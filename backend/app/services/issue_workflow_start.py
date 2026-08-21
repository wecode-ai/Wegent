# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Start the configured Issue orchestration when work enters Pending."""

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
            return 0
        if workflow.advancement_policy == "ai":
            return await self._start_ai(db, item, project, workflow, user_id)
        return await self._start_ready_stages(db, item, workflow, user_id)

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
            return 0
        planning_run = issue_workflow_planning_service.ensure_run(
            db,
            issue=item,
            user_id=user_id,
        )
        if self._has_run(db, item, rule_id, planning_run.id):
            return 0
        return await project_automation_processor.process(
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
                    "tags": list(
                        (item.metadata_json or {}).get("tags", [])
                        if isinstance(item.metadata_json, dict)
                        else []
                    ),
                },
            ),
            automation_id=rule_id,
        )

    async def _start_ready_stages(
        self,
        db: Session,
        item: LoopItem,
        workflow: IssueWorkflowInstance,
        user_id: int,
    ) -> int:
        started = 0
        for node in workflow.nodes:
            if node.status != "ready" or not node.automation_rule_id:
                continue
            await project_automation_service.run_for_workflow_node(
                db,
                str(item.cloud_project_id),
                node.automation_rule_id,
                str(item.id),
                node.id,
                user_id,
            )
            started += 1
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
            if (
                isinstance(payload, dict)
                and payload.get("workflow_run_id") == workflow_run_id
            ):
                return True
        return False


issue_workflow_start_service = IssueWorkflowStartService()
