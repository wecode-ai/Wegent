# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Start the configured Issue orchestration when work enters Pending."""

import logging

from sqlalchemy.orm import Session

from app.models.delivery import (
    CloudProject,
    LoopItem,
    ProjectAutomationRun,
    loop_datetime_is_unset,
)
from app.schemas.issue_workflow import IssueWorkflowInstance
from app.services.issue_workflow_planning import issue_workflow_planning_service
from app.services.project_automation_domain import ProjectAutomationEvent
from app.services.project_automations import (
    project_automation_processor,
    project_automation_service,
)

logger = logging.getLogger(__name__)


class IssueWorkflowStartService:
    """Enter an Issue's snapshotted orchestration exactly once."""

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
        started = await project_automation_processor.process(
            db,
            ProjectAutomationEvent(
                event_type="task.created",
                project_id=str(project.id),
                subject_id=str(item.id),
                source=project.task_provider,
                actor_user_id=user_id,
                payload={
                    "id": str(item.id),
                    "title": item.title,
                    "description": item.description,
                    "status": item.status,
                    "priority": item.priority,
                    "workflow_run_id": planning_run.id,
                    "workflow_plan_version": (planning_run.metadata_json or {}).get(
                        "plan_version"
                    ),
                    "execution_config": (
                        workflow.execution_config.model_dump(mode="json", by_alias=True)
                        if workflow.execution_config
                        else None
                    ),
                    "tags": list(
                        (item.metadata_json or {}).get("tags", [])
                        if isinstance(item.metadata_json, dict)
                        else []
                    ),
                },
            ),
            automation_id=rule_id,
        )
        logger.info(
            "[issue-workflow-start] AI workflow dispatched item=%s rule=%s "
            "planning_run=%s started=%s",
            item.id,
            rule_id,
            planning_run.id,
            started,
        )
        return started

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
            if (
                not existing_workflow_run_id
                or existing_workflow_run_id == workflow_run_id
            ):
                return True
        return False


issue_workflow_start_service = IssueWorkflowStartService()
