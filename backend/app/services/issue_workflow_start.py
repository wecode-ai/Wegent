# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Start the configured Issue orchestration when work enters processing."""

import logging

from sqlalchemy.orm import Session

from app.models.delivery import (
    CloudProject,
    LoopItem,
    ProjectAutomationRun,
    ProjectWorkflowRun,
    loop_datetime_is_unset,
)
from app.schemas.issue_workflow import IssueWorkflowInstance
from app.services.issue_execution_configuration import (
    require_coordinator_execution_config,
)
from app.services.issue_workflow_planning import issue_workflow_planning_service
from app.services.loop_item_status_history import is_processing_status
from app.services.project_automations import (
    project_automation_service,
)
from shared.telemetry.decorators import trace_async

logger = logging.getLogger(__name__)


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

    @trace_async(span_name="issue_workflow.start", tracer_name="backend.issue_workflow")
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

    async def review_outcomes(
        self,
        db: Session,
        *,
        item: LoopItem,
        project: CloudProject,
        user_id: int,
    ) -> int:
        """Ask the AI manager to judge reported child outcomes once."""

        workflow = self._workflow(item)
        if workflow is None or workflow.advancement_policy != "ai":
            return 0
        plan = issue_workflow_planning_service.get(
            db, issue_id=item.id, user_id=user_id
        )
        if plan is None or plan.status != "awaiting_review":
            return 0
        if not plan.items or any(
            entry.outcome_verdict not in {"passed", "needs_rework"}
            for entry in plan.items
        ):
            return 0
        run = (
            db.query(ProjectWorkflowRun)
            .filter(ProjectWorkflowRun.id == plan.run_id)
            .with_for_update()
            .one()
        )
        run_metadata = dict(run.metadata_json or {})
        if run_metadata.get("review_manager_run_id"):
            return 0
        rule_id = workflow.ai_automation_rule_id
        if not rule_id:
            raise ValueError("AI review requires a manager automation rule")
        outcomes = "\n".join(
            f"- {entry.title}: {entry.outcome_verdict or 'unreported'}; "
            f"{entry.outcome_summary}"
            for entry in plan.items
        )
        instruction = (
            f"{workflow.coordinator_prompt}\n\n"
            f"执行者回报：\n{outcomes}\n\n"
            "请结合 Issue 与子任务详情核查结果，调用 decide_workflow_review。"
        )
        feedback = run_metadata.get("user_review_feedback")
        if isinstance(feedback, dict):
            instruction += f"\n\n用户确认或修改意见：{feedback.get('text', '')}"
        started = await project_automation_service.run_ai_workflow_manager(
            db,
            project_id=str(project.id),
            automation_id=rule_id,
            item=item,
            workflow_run_id=plan.run_id,
            workflow_plan_version=plan.plan_version,
            user_id=user_id,
            coordinator_prompt=instruction,
            execution_config=(
                workflow.execution_config.model_dump(mode="json", by_alias=True)
                if workflow.execution_config
                else None
            ),
            phase="review",
        )
        run.metadata_json = {
            **run_metadata,
            "review_manager_run_id": started["id"],
        }
        db.commit()
        return 1

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
        require_coordinator_execution_config(workflow.execution_config)
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
            needs_config = workflow.node_needs_execution_config(node)
            logger.info(
                "[issue-workflow-start] node item=%s node=%s status=%s mode=%s "
                "rule=%s config_complete=%s needs_config=%s policy=%s "
                "agent=%s device=%s model=%s workspace=%s",
                item.id,
                node.id,
                node.status,
                node.execution_mode,
                node.automation_rule_id,
                bool(execution_config and execution_config.is_complete()),
                needs_config,
                node.workspace_policy,
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
            if needs_config:
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
