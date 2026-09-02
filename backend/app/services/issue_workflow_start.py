# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Start the configured Issue orchestration when work enters processing."""

import logging
from dataclasses import dataclass

from sqlalchemy.orm import Session

from app.models.delivery import (
    CloudProject,
    LoopItem,
    ProjectAutomationRun,
    loop_datetime_is_unset,
)
from app.schemas.issue_workflow import IssueWorkflowInstance
from app.services.chat.storage.db import get_db_session, run_sync_in_executor
from app.services.issue_workflow_planning import issue_workflow_planning_service
from app.services.loop_item_status_history import is_processing_status
from app.services.project_automations import (
    project_automation_service,
)

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class _WorkflowStageDispatch:
    """Scalar identity for one ready workflow stage."""

    project_id: str
    item_id: str
    node_id: str
    user_id: int
    automation_rule_id: str | None


@dataclass(frozen=True)
class _AIWorkflowDispatch:
    """Detached inputs needed to create one AI workflow manager run."""

    project_id: str
    automation_id: str
    item_id: str
    workflow_run_id: str
    workflow_plan_version: int | None
    user_id: int
    coordinator_prompt: str
    execution_config: dict | None


@dataclass(frozen=True)
class _WorkflowStartPlan:
    """Database-free work returned from a worker-owned transaction."""

    stages: tuple[_WorkflowStageDispatch, ...] = ()
    ai: _AIWorkflowDispatch | None = None


class IssueWorkflowStartService:
    """Enter an Issue's snapshotted orchestration exactly once."""

    def should_start_after_creation(
        self,
        item: LoopItem,
        project: CloudProject,
    ) -> bool:
        """Return whether a newly created Issue should start its workflow."""

        workflow = self._workflow(item)
        if workflow is None:
            return False
        if workflow.advancement_policy == "ai":
            return True
        return is_processing_status(project, item.status)

    async def start(
        self,
        db: Session,
        *,
        item: LoopItem,
        project: CloudProject,
        user_id: int,
    ) -> int:
        workflow = self._workflow(item)
        if workflow is None:
            logger.info(
                "[issue-workflow-start] skipped item=%s project=%s reason=no_workflow "
                "status=%s",
                item.id,
                item.cloud_project_id,
                getattr(item, "status", None),
            )
            return 0
        logger.info(
            "[issue-workflow-start] evaluating item=%s project=%s status=%s "
            "policy=%s stage_mode=%s nodes=%s user=%s",
            item.id,
            item.cloud_project_id,
            getattr(item, "status", None),
            workflow.advancement_policy,
            workflow.stage_mode,
            len(workflow.nodes),
            user_id,
        )
        if workflow.advancement_policy == "ai":
            return await self._start_ai(db, item, project, workflow, user_id)
        return await self._start_ready_stages(db, item, workflow, user_id)

    async def start_nonblocking(self, *, item_id: str, user_id: int) -> int:
        """Start a persisted workflow without using SQLAlchemy on the caller loop."""

        plan = await run_sync_in_executor(
            self._prepare_start_nonblocking_sync,
            item_id,
            user_id,
        )
        if plan.ai is not None:
            intent = plan.ai
            await project_automation_service.run_ai_workflow_manager_nonblocking(
                project_id=intent.project_id,
                automation_id=intent.automation_id,
                item_id=intent.item_id,
                workflow_run_id=intent.workflow_run_id,
                workflow_plan_version=intent.workflow_plan_version,
                user_id=intent.user_id,
                coordinator_prompt=intent.coordinator_prompt,
                execution_config=intent.execution_config,
            )
            return 1
        return await self._dispatch_stages_nonblocking(plan.stages)

    async def continue_ready_stages(
        self,
        db: Session,
        *,
        item: LoopItem,
        user_id: int,
        stage_ids: set[str],
    ) -> int:
        """Dispatch newly unblocked robot stages in a preset workflow."""

        workflow = self._workflow(item)
        if workflow is None or workflow.advancement_policy == "ai":
            return 0
        return await self._start_ready_stages(
            db,
            item,
            workflow,
            user_id,
            stage_ids=stage_ids,
        )

    async def continue_ready_stages_nonblocking(
        self,
        *,
        item_id: str,
        user_id: int,
        stage_ids: set[str],
    ) -> int:
        """Continue preset stages using worker-owned database transactions."""

        stages = await run_sync_in_executor(
            self._prepare_continuation_nonblocking_sync,
            item_id,
            user_id,
            frozenset(stage_ids),
        )
        return await self._dispatch_stages_nonblocking(stages)

    def _prepare_start_nonblocking_sync(
        self,
        item_id: str,
        user_id: int,
    ) -> _WorkflowStartPlan:
        with get_db_session() as db:
            item = db.get(LoopItem, item_id)
            if item is None:
                logger.warning(
                    "[issue-workflow-start] skipped item=%s reason=item_missing",
                    item_id,
                )
                return _WorkflowStartPlan()
            project = db.get(CloudProject, item.cloud_project_id)
            if project is None:
                logger.warning(
                    "[issue-workflow-start] skipped item=%s reason=project_missing",
                    item_id,
                )
                return _WorkflowStartPlan()
            workflow = self._workflow(item)
            if workflow is None:
                return _WorkflowStartPlan()
            if workflow.advancement_policy != "ai":
                return _WorkflowStartPlan(
                    stages=self._stage_dispatches(
                        item,
                        workflow,
                        user_id,
                        stage_ids=None,
                    )
                )
            return _WorkflowStartPlan(
                ai=self._prepare_ai_dispatch(db, item, workflow, user_id)
            )

    def _prepare_continuation_nonblocking_sync(
        self,
        item_id: str,
        user_id: int,
        stage_ids: frozenset[str],
    ) -> tuple[_WorkflowStageDispatch, ...]:
        with get_db_session() as db:
            item = db.get(LoopItem, item_id)
            if item is None:
                logger.warning(
                    "[IssueWorkflowContinuation] skipped item=%s "
                    "reason=item_missing stages=%s",
                    item_id,
                    sorted(stage_ids),
                )
                return ()
            workflow = self._workflow(item)
            if workflow is None or workflow.advancement_policy == "ai":
                return ()
            return self._stage_dispatches(
                item,
                workflow,
                user_id,
                stage_ids=set(stage_ids),
            )

    def _prepare_ai_dispatch(
        self,
        db: Session,
        item: LoopItem,
        workflow: IssueWorkflowInstance,
        user_id: int,
    ) -> _AIWorkflowDispatch | None:
        rule_id = workflow.ai_automation_rule_id
        if not rule_id:
            return None
        if (
            workflow.execution_config is not None
            and not workflow.execution_config.is_complete()
        ):
            return None
        planning_run = issue_workflow_planning_service.ensure_run(
            db,
            issue=item,
            user_id=user_id,
        )
        if self._has_run(db, item, rule_id, planning_run.id):
            return None
        return _AIWorkflowDispatch(
            project_id=str(item.cloud_project_id),
            automation_id=rule_id,
            item_id=str(item.id),
            workflow_run_id=str(planning_run.id),
            workflow_plan_version=(planning_run.metadata_json or {}).get(
                "plan_version"
            ),
            user_id=user_id,
            coordinator_prompt=workflow.coordinator_prompt,
            execution_config=(
                workflow.execution_config.model_dump(mode="json", by_alias=True)
                if workflow.execution_config
                else None
            ),
        )

    @staticmethod
    def _stage_dispatches(
        item: LoopItem,
        workflow: IssueWorkflowInstance,
        user_id: int,
        *,
        stage_ids: set[str] | None,
    ) -> tuple[_WorkflowStageDispatch, ...]:
        stages: list[_WorkflowStageDispatch] = []
        for node in workflow.nodes:
            if stage_ids is not None and node.id not in stage_ids:
                continue
            execution_config = workflow.execution_config_for(node)
            if (
                node.status != "ready"
                or node.execution_mode != "robot"
                or execution_config is None
                or not execution_config.is_complete()
            ):
                continue
            stages.append(
                _WorkflowStageDispatch(
                    project_id=str(item.cloud_project_id),
                    item_id=str(item.id),
                    node_id=node.id,
                    user_id=user_id,
                    automation_rule_id=node.automation_rule_id,
                )
            )
        return tuple(stages)

    @staticmethod
    async def _dispatch_stages_nonblocking(
        stages: tuple[_WorkflowStageDispatch, ...],
    ) -> int:
        started = 0
        for stage in stages:
            if stage.automation_rule_id:
                await project_automation_service.run_for_workflow_node_nonblocking(
                    project_id=stage.project_id,
                    automation_id=stage.automation_rule_id,
                    item_id=stage.item_id,
                    workflow_node_id=stage.node_id,
                    user_id=stage.user_id,
                )
            else:
                await project_automation_service.run_direct_workflow_node_nonblocking(
                    project_id=stage.project_id,
                    item_id=stage.item_id,
                    workflow_node_id=stage.node_id,
                    user_id=stage.user_id,
                )
            started += 1
        return started

    def ready_robot_stage_ids(self, item: LoopItem) -> set[str]:
        workflow = self._workflow(item)
        if workflow is None or workflow.advancement_policy == "ai":
            return set()
        return {
            node.id
            for node in workflow.nodes
            if node.status == "ready" and node.execution_mode == "robot"
        }

    @staticmethod
    def _workflow(item: LoopItem) -> IssueWorkflowInstance | None:
        metadata = item.metadata_json if isinstance(item.metadata_json, dict) else {}
        raw_workflow = metadata.get("workflow")
        if not isinstance(raw_workflow, dict):
            return None
        workflow = IssueWorkflowInstance.model_validate(raw_workflow)
        if workflow.stage_mode == "none" and workflow.advancement_policy == "manual":
            return None
        return workflow

    async def _start_ai(
        self,
        db: Session,
        item: LoopItem,
        project: CloudProject,
        workflow: IssueWorkflowInstance,
        user_id: int,
    ) -> int:
        rule_id = workflow.ai_automation_rule_id
        if not rule_id:
            logger.info(
                "[issue-workflow-start] skipped AI workflow item=%s "
                "reason=missing_ai_automation_rule",
                item.id,
            )
            return 0
        if (
            workflow.execution_config is not None
            and not workflow.execution_config.is_complete()
        ):
            logger.info(
                "[issue-workflow-start] skipped AI workflow item=%s "
                "reason=incomplete_execution_config",
                item.id,
            )
            return 0
        planning_run = issue_workflow_planning_service.ensure_run(
            db,
            issue=item,
            user_id=user_id,
        )
        if self._has_run(db, item, rule_id, planning_run.id):
            logger.info(
                "[issue-workflow-start] skipped AI workflow item=%s rule=%s "
                "planning_run=%s reason=already_started",
                item.id,
                rule_id,
                planning_run.id,
            )
            return 0
        started_run = await project_automation_service.run_ai_workflow_manager(
            db,
            project_id=str(project.id),
            automation_id=rule_id,
            item=item,
            workflow_run_id=str(planning_run.id),
            workflow_plan_version=(planning_run.metadata_json or {}).get(
                "plan_version"
            ),
            user_id=user_id,
            coordinator_prompt=workflow.coordinator_prompt,
            execution_config=(
                workflow.execution_config.model_dump(mode="json", by_alias=True)
                if workflow.execution_config
                else None
            ),
        )
        logger.info(
            "[issue-workflow-start] AI workflow dispatched item=%s rule=%s "
            "planning_run=%s started=%s",
            item.id,
            rule_id,
            planning_run.id,
            started_run.get("id"),
        )
        return 1

    async def _start_ready_stages(
        self,
        db: Session,
        item: LoopItem,
        workflow: IssueWorkflowInstance,
        user_id: int,
        *,
        stage_ids: set[str] | None = None,
    ) -> int:
        started = 0
        for node in workflow.nodes:
            if stage_ids is not None and node.id not in stage_ids:
                continue
            execution_config = workflow.execution_config_for(node)
            logger.info(
                "[issue-workflow-start] node item=%s node=%s status=%s mode=%s "
                "rule=%s config_complete=%s agent=%s device=%s model=%s "
                "workspace=%s",
                item.id,
                node.id,
                node.status,
                node.execution_mode,
                node.automation_rule_id,
                bool(execution_config and execution_config.is_complete()),
                bool(execution_config and execution_config.agent_id),
                bool(execution_config and execution_config.execution_device_id),
                bool(execution_config and execution_config.model),
                bool(execution_config and execution_config.workspace_binding),
            )
            if node.status != "ready":
                logger.info(
                    "[issue-workflow-start] node skipped item=%s node=%s "
                    "reason=status_not_ready status=%s",
                    item.id,
                    node.id,
                    node.status,
                )
                continue
            if node.execution_mode != "robot":
                logger.info(
                    "[issue-workflow-start] node skipped item=%s node=%s "
                    "reason=human_execution",
                    item.id,
                    node.id,
                )
                continue
            if execution_config is None or not execution_config.is_complete():
                logger.info(
                    "[issue-workflow-start] node skipped item=%s node=%s "
                    "reason=incomplete_execution_config",
                    item.id,
                    node.id,
                )
                continue
            if node.automation_rule_id:
                run = await project_automation_service.run_for_workflow_node(
                    db,
                    str(item.cloud_project_id),
                    node.automation_rule_id,
                    str(item.id),
                    node.id,
                    user_id,
                )
            else:
                run = await project_automation_service.run_direct_workflow_node(
                    db,
                    str(item.cloud_project_id),
                    str(item.id),
                    node.id,
                    user_id,
                )
            started += 1
            logger.info(
                "[issue-workflow-start] node dispatched item=%s node=%s rule=%s "
                "run=%s",
                item.id,
                node.id,
                node.automation_rule_id,
                run.get("id") if isinstance(run, dict) else None,
            )
        logger.info(
            "[issue-workflow-start] completed item=%s started=%s nodes=%s",
            item.id,
            started,
            len(workflow.nodes),
        )
        return started

    @staticmethod
    def _has_run(
        db: Session,
        item: LoopItem,
        rule_id: str,
        workflow_run_id: str,
    ) -> bool:
        runs = (
            db.query(ProjectAutomationRun)
            .filter(
                ProjectAutomationRun.cloud_project_id == item.cloud_project_id,
                ProjectAutomationRun.parent_id == rule_id,
                ProjectAutomationRun.task_id == item.id,
                loop_datetime_is_unset(ProjectAutomationRun.deleted_at),
            )
            .all()
        )
        for run in runs:
            metadata = run.metadata_json if isinstance(run.metadata_json, dict) else {}
            event = metadata.get("event")
            payload = event.get("payload") if isinstance(event, dict) else None
            existing_workflow_run_id = (
                payload.get("workflow_run_id") if isinstance(payload, dict) else None
            )
            if existing_workflow_run_id == workflow_run_id:
                return True
        return False


issue_workflow_start_service = IssueWorkflowStartService()
