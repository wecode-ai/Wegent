# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Continue the Issue coordinator conversation after an explicit human handoff."""

import uuid
from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy.orm import Session

from app.models.delivery import (
    LoopItem,
    ProjectAutomationRun,
    ProjectWorkflowRun,
)
from app.models.kind import Kind
from app.models.loop_item_execution import LoopItemExecution
from app.models.project_chat_message import ProjectChatMessage
from app.models.task import TaskResource
from app.models.user import User
from app.schemas.runtime_work import (
    RuntimeModelSelection,
    RuntimeSendRequest,
    RuntimeTaskAddress,
)
from app.services import runtime_work_service
from app.services.chat.storage.task_manager import TaskCreationParams, create_chat_task
from app.services.issue_assignment_comments import queue_assignment_comment
from app.services.issue_workflow_planning import issue_workflow_planning_service
from app.services.loop_item_executions.service import loop_item_execution_service
from app.services.project_automation_execution import project_automation_execution
from app.services.project_automation_managed_execution import (
    ManagedTeamExecutionHandle,
    project_automation_managed_execution_service,
)
from app.services.project_chat.service import project_chat_service
from app.stores.tasks import task_store
from shared.telemetry.decorators import trace_async


@dataclass(frozen=True)
class _CoordinatorContext:
    planning: ProjectWorkflowRun
    run: ProjectAutomationRun
    activity: ProjectChatMessage
    owner: User
    manager_type: str


@dataclass(frozen=True)
class _WegentTurn:
    handle: ManagedTeamExecutionHandle
    user_subtask_id: int
    team_id: int


class IssueAssignmentContinuationService:
    """Create a coordinator turn on an existing conversation."""

    @trace_async(
        span_name="issue_assignment.continue_coordinator",
        tracer_name="backend.workflow",
    )
    async def continue_coordinator(
        self,
        db: Session,
        *,
        issue: LoopItem,
        workflow: dict,
        assignment_id: str,
        summary: str,
    ) -> None:
        previous_planning_id = str(workflow.get("active_run_id") or "")
        context = None
        planning = None
        run = None
        response = None
        wegent_turn = None
        continuation_execution = None
        try:
            context = self._context(db, issue=issue, workflow=workflow)
            trigger = self._human_reply(db, issue=issue, workflow=workflow)
            prompt = self._prompt(issue.id, assignment_id, summary)
            planning = self._new_planning_run(
                db,
                issue=issue,
                workflow=workflow,
                user_id=context.owner.id,
            )
            run = self._new_automation_run(
                db,
                context=context,
                planning=planning,
            )
            response = self._response(issue, context, run, trigger)
            db.add(response)
            run.metadata_json = {
                **(run.metadata_json or {}),
                "activity_message_id": response.message_id,
            }
            planning.metadata_json = {
                **(planning.metadata_json or {}),
                "project_automation_run_id": str(run.id),
            }
            db.flush()
            custom_model_selection = None
            if context.manager_type == "custom":
                previous_execution = self._custom_execution(
                    db, issue=issue, context=context
                )
                custom_model_selection = (
                    loop_item_execution_service.runtime_model_selection(
                        previous_execution
                    )
                )
                if custom_model_selection is None:
                    raise ValueError("The original coordinator model is unavailable")
                continuation_execution = (
                    loop_item_execution_service.begin_runtime_continuation(
                        db,
                        previous_execution=previous_execution,
                        automation_run_id=str(run.id),
                        activity=response,
                        client_user_message_id=trigger.message_id,
                    )
                )
            elif context.manager_type == "wegent":
                wegent_turn = await self._prepare_wegent_turn(
                    db,
                    context=context,
                    run=run,
                    response=response,
                    prompt=prompt,
                )
            else:
                raise ValueError(
                    "The original coordinator conversation type is unavailable"
                )
            queue_assignment_comment(db, response)
            db.commit()
            if wegent_turn is None:
                await self._send_custom(
                    db,
                    context=context,
                    run=run,
                    execution=continuation_execution,
                    trigger=trigger,
                    prompt=prompt,
                    model_selection=custom_model_selection,
                )
            else:
                self._dispatch_wegent(context, wegent_turn, prompt)
        except Exception as exc:
            db.rollback()
            self._restore_waiting_human(
                db,
                issue_id=issue.id,
                assignment_id=assignment_id,
                previous_planning_id=previous_planning_id,
                planning_id=str(planning.id) if planning is not None else None,
                run_id=str(run.id) if run is not None else None,
                execution_id=(
                    continuation_execution.id if continuation_execution else None
                ),
                response_id=response.message_id if response is not None else None,
                error=str(exc) or "Original coordinator continuation failed",
            )
            raise ValueError(
                "The original coordinator conversation could not be continued; "
                "your reply was saved and remains waiting for you to continue again"
            ) from exc

    @staticmethod
    def _context(
        db: Session, *, issue: LoopItem, workflow: dict
    ) -> _CoordinatorContext:
        planning_id = str(workflow.get("active_run_id") or "")
        planning = db.get(ProjectWorkflowRun, planning_id) if planning_id else None
        run = (
            issue_workflow_planning_service.manager_automation_run(
                db, workflow_run_id=planning_id
            )
            if planning is not None
            else None
        )
        activity = project_automation_execution._activity(db, run) if run else None
        owner = db.get(User, run.created_by_user_id) if run else None
        metadata = (
            activity.metadata_json
            if activity and isinstance(activity.metadata_json, dict)
            else {}
        )
        manager_type = str(metadata.get("manager_type") or "")
        if planning is None or run is None or activity is None or owner is None:
            raise ValueError("The original coordinator conversation is unavailable")
        return _CoordinatorContext(
            planning=planning,
            run=run,
            activity=activity,
            owner=owner,
            manager_type=manager_type,
        )

    @staticmethod
    def _new_planning_run(
        db: Session,
        *,
        issue: LoopItem,
        workflow: dict,
        user_id: int,
    ) -> ProjectWorkflowRun:
        next_workflow = dict(workflow)
        next_workflow.update(active_run_id=None, orchestration_status="planning")
        issue_workflow_planning_service._write_workflow(issue, next_workflow)
        return issue_workflow_planning_service.ensure_run(
            db,
            issue=issue,
            user_id=user_id,
        )

    @staticmethod
    def _new_automation_run(
        db: Session,
        *,
        context: _CoordinatorContext,
        planning: ProjectWorkflowRun,
    ) -> ProjectAutomationRun:
        metadata = deepcopy(context.run.metadata_json or {})
        metadata.pop("activity_message_id", None)
        metadata.pop("error", None)
        event = deepcopy(metadata.get("event") or {})
        payload = deepcopy(event.get("payload") or {})
        payload["workflow_run_id"] = str(planning.id)
        payload["workflow_plan_version"] = (planning.metadata_json or {}).get(
            "plan_version"
        )
        event["payload"] = payload
        metadata.update(
            event=event,
            trigger="human_continue",
            continuation_of_run_id=str(context.run.id),
        )
        run = ProjectAutomationRun(
            cloud_project_id=context.run.cloud_project_id,
            parent_id=context.run.parent_id,
            task_id=context.run.task_id,
            task_title=context.run.task_title,
            source="human_continue",
            status="queued",
            created_by_user_id=context.run.created_by_user_id,
            updated_by_user_id=context.run.created_by_user_id,
            assignee_agent_id=context.run.assignee_agent_id,
            device_id=context.run.device_id,
            metadata_json=metadata,
        )
        db.add(run)
        db.flush()
        return run

    @staticmethod
    def _human_reply(
        db: Session, *, issue: LoopItem, workflow: dict
    ) -> ProjectChatMessage:
        message_id = str(
            (workflow.get("assignment") or {}).get("reply_message_id") or ""
        )
        row = (
            db.query(ProjectChatMessage)
            .filter(
                ProjectChatMessage.message_id == message_id,
                ProjectChatMessage.project_id == str(issue.cloud_project_id),
                ProjectChatMessage.task_id == str(issue.id),
                ProjectChatMessage.sender_type == "user",
            )
            .one_or_none()
        )
        if row is None:
            raise ValueError("The human reply is unavailable")
        return row

    @staticmethod
    def _prompt(issue_id: str, assignment_id: str, summary: str) -> str:
        return (
            "human_continue callback\n"
            f"item_id: {issue_id}\n"
            f"assignment_id: {assignment_id}\n\n"
            "The assigned person explicitly returned control to you in the existing "
            "Issue discussion. Continue this same conversation. Read get_board_item "
            "and list_board_item_comments, then decide the next assignment once. "
            f"The previous request_id was {assignment_id}; it identifies the finished "
            "assignment and MUST NOT be reused. Generate a new unique request_id for "
            "your next decision.\n\n"
            f"Human reply:\n{summary}"
        )

    @staticmethod
    def _response(
        issue: LoopItem,
        context: _CoordinatorContext,
        run: ProjectAutomationRun,
        trigger: ProjectChatMessage,
    ) -> ProjectChatMessage:
        message_id = str(uuid.uuid7()) if hasattr(uuid, "uuid7") else str(uuid.uuid4())
        activity_metadata = (
            context.activity.metadata_json
            if isinstance(context.activity.metadata_json, dict)
            else {}
        )
        metadata = {
            "kind": "issue_assignment_continuation",
            "automation_run_id": str(run.id),
            "assignment_mode": "ai_managed",
            "manager_type": context.manager_type,
            "run_id": str(run.id),
            "run_status": "queued",
            "continuation_of_run_id": str(context.run.id),
        }
        if activity_metadata.get("backend_task_id") is not None:
            metadata["backend_task_id"] = activity_metadata["backend_task_id"]
        return ProjectChatMessage(
            message_id=message_id,
            client_message_id=message_id,
            project_id=str(issue.cloud_project_id),
            task_id=str(issue.id),
            sender_type="agent",
            sender_id=context.activity.sender_id,
            sender_name=context.activity.sender_name,
            message_type="agent_chunk",
            content="",
            metadata_json=metadata,
            trigger_message_id=trigger.message_id,
            reply_to_message_id=trigger.message_id,
            thread_root_message_id=(
                trigger.thread_root_message_id or trigger.message_id
            ),
            runtime_device_id=context.activity.runtime_device_id,
            runtime_task_id=context.activity.runtime_task_id,
            status="pending",
        )

    @staticmethod
    def _custom_execution(
        db: Session, *, issue: LoopItem, context: _CoordinatorContext
    ) -> LoopItemExecution:
        project_chat_service._custom_manager_reply_target(
            db,
            project_id=str(issue.cloud_project_id),
            task_id=str(issue.id),
            message_id=context.activity.message_id,
        )
        metadata = (
            context.activity.metadata_json
            if isinstance(context.activity.metadata_json, dict)
            else {}
        )
        try:
            execution_id = int(metadata["execution_id"])
        except (KeyError, TypeError, ValueError) as exc:
            raise ValueError(
                "The original coordinator execution is unavailable"
            ) from exc
        execution = db.get(LoopItemExecution, execution_id)
        if (
            execution is None
            or execution.executor_owner_user_id != context.owner.id
            or execution.automation_run_id != context.run.id
        ):
            raise ValueError("The original coordinator execution is unavailable")
        return execution

    @staticmethod
    async def _prepare_wegent_turn(
        db: Session,
        *,
        context: _CoordinatorContext,
        run: ProjectAutomationRun,
        response: ProjectChatMessage,
        prompt: str,
    ) -> _WegentTurn:
        task_id = int(context.run.backend_task_id or 0)
        task = task_store.get_by_id_for_update(
            db, task_id=task_id, owner_user_id=context.owner.id
        )
        if task is None:
            raise ValueError("The original coordinator task is unavailable")
        team = IssueAssignmentContinuationService._wegent_team(
            db, context=context, task=task
        )
        created = await create_chat_task(
            db=db,
            user=context.owner,
            team=team,
            message=prompt,
            params=TaskCreationParams(
                message=prompt,
                title=context.run.task_title or "AI coordinator",
                task_type="chat",
                source="project_automation",
                auto_delete_executor="true",
            ),
            task_id=task.id,
            should_trigger_ai=True,
            source="project_automation",
            commit=False,
        )
        if created.assistant_subtask is None:
            raise ValueError(
                "The original coordinator Task could not open another turn"
            )
        task_json = deepcopy(created.task.json or {})
        current_labels = task_json.setdefault("metadata", {}).setdefault("labels", {})
        current_labels["projectAutomationRunId"] = str(run.id)
        current_labels["projectAutomationSubtaskId"] = str(created.assistant_subtask.id)
        current_labels["projectChatMessageId"] = response.message_id
        task_store.update_json(db, task=created.task, payload=task_json)
        run.backend_task_id = task.id
        response.metadata_json = {
            **response.metadata_json,
            "backend_task_id": task.id,
            "backend_subtask_id": created.assistant_subtask.id,
        }
        return _WegentTurn(
            handle=ManagedTeamExecutionHandle(task.id, created.assistant_subtask.id),
            user_subtask_id=created.user_subtask.id,
            team_id=team.id,
        )

    @staticmethod
    def _wegent_team(
        db: Session, *, context: _CoordinatorContext, task: TaskResource
    ) -> Kind:
        labels = project_automation_managed_execution_service._labels(task)
        if str(labels.get("projectAutomationRunId") or "") != str(context.run.id):
            raise ValueError(
                "The original coordinator task no longer matches this Issue"
            )
        try:
            team_id = int(labels["projectAutomationTeamId"])
        except (KeyError, TypeError, ValueError) as exc:
            raise ValueError("The original coordinator Team is unavailable") from exc
        team = db.get(Kind, team_id)
        if (
            team is None
            or team.kind != "Team"
            or not team.is_active
            or team.user_id != context.owner.id
        ):
            raise ValueError("The original coordinator Team is unavailable")
        return team

    @staticmethod
    async def _send_custom(
        db: Session,
        *,
        context: _CoordinatorContext,
        run: ProjectAutomationRun,
        execution: LoopItemExecution | None,
        trigger: ProjectChatMessage,
        prompt: str,
        model_selection: RuntimeModelSelection,
    ) -> None:
        if execution is None:
            raise ValueError("The coordinator continuation execution is unavailable")
        result = await runtime_work_service.send_runtime_message(
            db=db,
            user_id=context.owner.id,
            request=RuntimeSendRequest(
                address=RuntimeTaskAddress(
                    deviceId=context.activity.runtime_device_id,
                    taskId=context.activity.runtime_task_id,
                ),
                message=prompt,
                modelSelection=model_selection,
                clientUserMessageId=trigger.message_id,
            ),
            allow_app_device_task_messaging=True,
            execution_origin={
                "type": "project_automation",
                "automationRole": "manager",
                "run_id": str(run.id),
                "executionId": execution.id,
                "cloudProjectId": str(run.cloud_project_id),
                "loopItemId": str(run.task_id or ""),
                "projectChatMessageId": str(
                    (run.metadata_json or {}).get("activity_message_id") or ""
                ),
            },
        )
        if not result.accepted:
            raise RuntimeError(result.error or "Runtime rejected the continuation")

    @staticmethod
    def _dispatch_wegent(
        context: _CoordinatorContext, turn: _WegentTurn, prompt: str
    ) -> None:
        from app.tasks.project_automation_tasks import (
            execute_managed_project_automation,
        )

        try:
            execute_managed_project_automation.delay(
                task_id=turn.handle.task_id,
                assistant_subtask_id=turn.handle.subtask_id,
                user_subtask_id=turn.user_subtask_id,
                team_id=turn.team_id,
                user_id=context.owner.id,
                prompt=prompt,
                source="project_automation",
            )
        except Exception as exc:
            project_automation_managed_execution_service.mark_dispatch_failed(
                task_id=turn.handle.task_id,
                user_id=context.owner.id,
                error=str(exc)
                or "Original coordinator continuation could not be queued",
            )
            raise

    @staticmethod
    def _restore_waiting_human(
        db: Session,
        *,
        issue_id: str,
        assignment_id: str,
        previous_planning_id: str,
        planning_id: str | None,
        run_id: str | None,
        execution_id: int | None,
        response_id: str | None,
        error: str,
    ) -> None:
        if execution_id is not None:
            execution = db.get(LoopItemExecution, execution_id)
            if execution is not None and execution.status not in {
                "completed",
                "failed",
                "cancelled",
            }:
                loop_item_execution_service.fail(
                    db,
                    execution_id=execution.id,
                    error=error,
                    requeue=False,
                )
        db.expire_all()
        issue = (
            db.query(LoopItem).filter(LoopItem.id == issue_id).with_for_update().one()
        )
        workflow = dict((issue.metadata_json or {}).get("workflow") or {})
        assignment = dict(workflow.get("assignment") or {})
        if assignment.get("id") == assignment_id:
            assignment.update(status="waiting_human", result=None)
            workflow.update(
                assignment=assignment,
                orchestration_status="waiting_human",
                active_run_id=previous_planning_id,
            )
            issue.metadata_json = {**(issue.metadata_json or {}), "workflow": workflow}
            issue.assignee_user_id = assignment.get("assignee_user_id")
        planning = db.get(ProjectWorkflowRun, planning_id) if planning_id else None
        run = db.get(ProjectAutomationRun, run_id) if run_id else None
        response = (
            db.query(ProjectChatMessage).filter_by(message_id=response_id).one_or_none()
            if response_id
            else None
        )
        if planning is not None:
            planning.status = "failed"
        if run is not None and run.status not in {"succeeded", "failed", "cancelled"}:
            run.status = "failed"
            run.completed_at = datetime.utcnow()
            run.description = error
        if response is not None:
            response.status = "failed"
            response.content = error
            response.metadata_json = {
                **(response.metadata_json or {}),
                "run_status": "failed",
            }
            queue_assignment_comment(db, response)
        db.commit()


issue_assignment_continuation_service = IssueAssignmentContinuationService()
