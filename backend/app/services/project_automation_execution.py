# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Execution orchestration and event processing for project automations."""

from __future__ import annotations

import hashlib
import json
import logging
import uuid
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any, Protocol
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.delivery import (
    CloudProject,
    LoopItem,
    LoopItemTaskBinding,
    ProjectAutomationRule,
    ProjectAutomationRun,
    ProjectChatAgent,
    loop_datetime_is_unset,
    loop_unset_datetime_for_connection,
)
from app.models.loop_item_execution import LoopItemExecution
from app.models.project_chat_message import ProjectChatMessage
from app.models.user import User
from app.schemas.delivery import LoopItemCreate
from app.schemas.issue_workflow import (
    ProjectWorkflowDefinition,
)
from app.schemas.project_chat import LoopItemAssign
from app.schemas.runtime_work import (
    RuntimeModelSelection,
    RuntimeSendRequest,
    RuntimeTaskAddress,
)
from app.services import runtime_work_service
from app.services.cloud_projects.service import cloud_project_service
from app.services.loop_item_executions.service import loop_item_execution_service
from app.services.loop_item_status_history import project_status_transition
from app.services.loop_items.external_provider import external_loop_item_provider
from app.services.loop_items.provider_router import loop_item_provider_router
from app.services.loop_items.service import loop_item_service
from app.services.project_automation_domain import (
    TERMINAL_RUN_STATUSES,
    ProjectAutomationEvent,
    integer,
    metadata,
    project_agent,
    runnable_wegent_team,
    runtime_config,
    text,
    utcnow,
)
from app.services.project_change_request_bindings import (
    project_change_request_binding_service,
)
from app.services.project_chat.push import push_project_chat_message
from app.services.project_chat.service import project_chat_service
from app.services.project_event_sources import supported_event_type
from shared.telemetry.decorators import trace_async

logger = logging.getLogger(__name__)
if TYPE_CHECKING:
    from app.schemas.issue_workflow import WorkflowPlanSubmit, WorkflowPlanView


class AutomationRunNotRetryable(RuntimeError):
    """The persisted run is not a failed, idle processor record."""


class AutomationRunFactory(Protocol):
    def __call__(
        self,
        db: Session,
        rule: ProjectAutomationRule,
        trigger: str,
        scheduled_for: datetime,
        *,
        public_id: str | None = None,
        commit: bool = True,
    ) -> ProjectAutomationRun: ...


class ProjectAutomationExecution:
    """Turn one persisted automation run into one concrete executor run."""

    @trace_async(
        span_name="project_automation.execution.dispatch",
        tracer_name="backend.project_automation",
        extract_attributes=lambda self, db, rule, run: {
            "automation.rule.id": str(rule.id),
            "automation.run.id": str(run.id),
            "automation.dispatch.target_kind": str(
                (metadata(rule).get("dispatch_target") or {}).get("kind") or ""
            ),
        },
    )
    async def dispatch(
        self, db: Session, rule: ProjectAutomationRule, run: ProjectAutomationRun
    ) -> None:
        if run.status not in {"pending", "queued"}:
            return
        try:
            owner = db.get(User, rule.created_by_user_id)
            project = db.get(CloudProject, rule.cloud_project_id)
            if owner is None or project is None:
                raise RuntimeError("Automation owner or project is unavailable")
            run_metadata = metadata(run)
            if not text(run_metadata.get("task_origin")):
                run_metadata["task_origin"] = (
                    "existing_issue" if run.task_id else "automation_created"
                )
                run.metadata_json = run_metadata
            self._ensure_run_task(db, project=project, owner=owner, rule=rule, run=run)
            dispatch_target = metadata(rule).get("dispatch_target")
            if not isinstance(dispatch_target, dict):
                raise RuntimeError("Automation dispatch target is unavailable")
            await self._dispatch_configured_target(
                db,
                owner=owner,
                project=project,
                rule=rule,
                run=run,
                dispatch_target=dispatch_target,
            )
        except Exception as exc:
            db.rollback()
            logger.exception(
                "[ProjectAutomation] Dispatch failed rule=%s run=%s",
                rule.id,
                run.id,
            )
            self._fail_run(db, run_id=str(run.id), error=str(exc) or "Dispatch failed")

    @staticmethod
    def _workflow_definition(
        rule: ProjectAutomationRule,
    ) -> ProjectWorkflowDefinition | None:
        event_config = metadata(rule).get("event_config")
        if not isinstance(event_config, dict):
            return None
        raw_definition = event_config.get("runtime_workflow_definition")
        if not isinstance(raw_definition, dict):
            return None
        return ProjectWorkflowDefinition.model_validate(raw_definition)

    def _ensure_run_task(
        self,
        db: Session,
        *,
        project: CloudProject,
        owner: User,
        rule: ProjectAutomationRule,
        run: ProjectAutomationRun,
    ) -> None:
        if run.task_id:
            task = loop_item_execution_service.resolve_task_context(
                db,
                execution=LoopItemExecution(
                    loop_item_id=str(run.task_id),
                    cloud_project_id=str(project.id),
                ),
                user_id=owner.id,
            )
            if task is None:
                raise RuntimeError("Automation event task is unavailable")
            return

        scheduled_for = self._scheduled_for(run)
        timezone_name = str(metadata(rule).get("timezone") or "Asia/Shanghai")
        try:
            local_time = scheduled_for.replace(tzinfo=timezone.utc).astimezone(
                ZoneInfo(timezone_name)
            )
        except ZoneInfoNotFoundError:
            local_time = scheduled_for
        context = self._automation_context(db, rule, run)
        instruction = self._run_instruction(rule, run)
        routed = loop_item_provider_router.create(
            db,
            project,
            owner,
            LoopItemCreate(
                title=f"{rule.title} · {local_time:%Y-%m-%d %H:%M}",
                description=instruction,
                priority="medium",
                tags=["automation"],
            ),
            automation_context=context,
            instruction=instruction,
            assign_creator_if_unassigned=False,
        )
        item_id = routed.values.get("id")
        if not item_id:
            raise RuntimeError("Automation task carrier was not created")
        run.task_id = str(item_id)
        item_title = routed.values.get("title")
        run.task_title = str(item_title) if item_title else ""
        run.version += 1
        db.commit()
        db.refresh(run)

    def _assign_project_robot(
        self,
        db: Session,
        *,
        owner: User,
        rule: ProjectAutomationRule,
        run: ProjectAutomationRun,
        agent_id: str | None,
        context: dict,
        instruction: str,
    ) -> None:
        agent = project_agent(db, str(rule.cloud_project_id), agent_id)
        if not run.task_id:
            raise RuntimeError("Automation task carrier is unavailable")
        uses_workflow_snapshot = "workspace_binding" in context
        robot_context = {
            **context,
            "runtime_source": (
                context.get("runtime_source")
                if uses_workflow_snapshot
                else "agent_default"
            )
            or "agent_default",
            "runtime_profile_id": (
                context.get("runtime_profile_id") if uses_workflow_snapshot else None
            ),
            "runtime_subject_user_id": int(
                (
                    context.get("runtime_subject_user_id")
                    if uses_workflow_snapshot
                    else None
                )
                or agent.created_by_user_id
                or owner.id
            ),
        }
        item = db.get(LoopItem, run.task_id)
        if item is not None:
            loop_item_service.assign(
                db,
                project_id=int(str(rule.cloud_project_id)),
                item_id=item.id,
                user_id=owner.id,
                values=LoopItemAssign(
                    assignee_type="agent",
                    assignee_id=agent.id,
                    version=item.version,
                ),
                automation_context=robot_context,
                instruction=instruction,
            )
        elif external_loop_item_provider.is_external_item(db, run.task_id):
            external_loop_item_provider.assign(
                db,
                run.task_id,
                owner.id,
                LoopItemAssign(assignee_type="agent", assignee_id=agent.id, version=1),
                automation_context=robot_context,
                instruction=instruction,
            )
        else:
            raise RuntimeError("Automation task carrier is unavailable")
        execution = self._project_robot_execution_for_run(db, str(run.id))
        if execution is None:
            raise RuntimeError("Project robot execution was not created")
        run.assignee_agent_id = agent.id
        run.device_id = execution.execution_device_id
        run.status = "queued"
        run.version += 1
        db.commit()
        if execution.team_id:
            from app.services.board_team_execution import (
                schedule_board_robot_execution,
            )

            schedule_board_robot_execution(db, execution)
        logger.info(
            "[ProjectAutomation] Queued project robot run=%s execution=%s device=%s",
            run.id,
            execution.id,
            execution.execution_device_id,
        )

    async def _dispatch_configured_target(
        self,
        db: Session,
        *,
        owner: User,
        project: CloudProject,
        rule: ProjectAutomationRule,
        run: ProjectAutomationRun,
        dispatch_target: dict[str, Any],
    ) -> None:
        """Apply the shared human, Agent, or collaboration-group target."""

        target_kind = str(dispatch_target.get("kind") or "")
        target_id = str(dispatch_target.get("id") or "")
        workflow_step: str | None = None
        context = self._automation_context(db, rule, run)
        configured_device = text(dispatch_target.get("execution_device_id"))
        if configured_device:
            context["execution_device_id"] = configured_device

        if target_kind == "human":
            self._assign_human_target(
                db,
                owner=owner,
                rule=rule,
                run=run,
                target_id=target_id,
                workflow_step=workflow_step,
                context=context,
            )
            return
        if target_kind != "agent":
            raise RuntimeError("The automatic-processing target is invalid")

        agent = self._project_agent_for_group_member(
            db,
            project_id=str(rule.cloud_project_id),
            member_id=target_id,
        )
        if agent is not None:
            self._assign_project_robot(
                db,
                owner=owner,
                rule=rule,
                run=run,
                agent_id=agent.id,
                context=context,
                instruction=self._run_instruction(rule, run),
            )
            return
        if not target_id.isdigit():
            raise RuntimeError("The collaboration-group Agent is unavailable")
        team = runnable_wegent_team(db, owner.id, int(target_id))
        self._assign_team_target(
            db,
            owner=owner,
            rule=rule,
            run=run,
            team_id=str(team.id),
            workflow_step=workflow_step,
            context=context,
        )

    @staticmethod
    def _project_agent_for_group_member(
        db: Session, *, project_id: str, member_id: str
    ) -> ProjectChatAgent | None:
        rows = (
            db.query(ProjectChatAgent)
            .filter(
                ProjectChatAgent.cloud_project_id == project_id,
                ProjectChatAgent.status == "active",
            )
            .all()
        )
        return next(
            (
                agent
                for agent in rows
                if str(agent.id) == member_id
                or (
                    member_id.isdigit()
                    and isinstance(agent.metadata_json, dict)
                    and agent.metadata_json.get("wegent_team_id") == int(member_id)
                )
            ),
            None,
        )

    def _assign_human_target(
        self,
        db: Session,
        *,
        owner: User,
        rule: ProjectAutomationRule,
        run: ProjectAutomationRun,
        target_id: str,
        workflow_step: str | None,
        context: dict[str, Any],
    ) -> None:
        self._assign_non_robot_target(
            db,
            owner=owner,
            rule=rule,
            run=run,
            assignee_type="user",
            assignee_id=target_id,
            workflow_step=workflow_step,
            context=context,
        )
        run.status = "succeeded"
        run.completed_at = utcnow()
        run.version += 1
        db.commit()

    def _assign_team_target(
        self,
        db: Session,
        *,
        owner: User,
        rule: ProjectAutomationRule,
        run: ProjectAutomationRun,
        team_id: str,
        workflow_step: str | None,
        context: dict[str, Any],
    ) -> None:
        self._assign_non_robot_target(
            db,
            owner=owner,
            rule=rule,
            run=run,
            assignee_type="team",
            assignee_id=team_id,
            workflow_step=workflow_step,
            context=context,
        )
        execution = self._project_robot_execution_for_run(db, str(run.id))
        if execution is None:
            raise RuntimeError("The collaboration-group Agent Run was not created")
        run.status = "queued"
        run.version += 1
        db.commit()
        from app.services.board_team_execution import schedule_board_robot_execution

        schedule_board_robot_execution(db, execution)

    @staticmethod
    def _assign_non_robot_target(
        db: Session,
        *,
        owner: User,
        rule: ProjectAutomationRule,
        run: ProjectAutomationRun,
        assignee_type: str,
        assignee_id: str,
        workflow_step: str | None,
        context: dict[str, Any],
    ) -> None:
        if not run.task_id:
            raise RuntimeError("Automatic processing has no Issue to assign")
        values = LoopItemAssign(
            assignee_type=assignee_type,
            assignee_id=assignee_id,
            workflow_step=workflow_step,
            notify_assignee=True,
            version=1,
            trigger="automation",
        )
        item = db.get(LoopItem, run.task_id)
        if item is not None:
            loop_item_service.assign(
                db,
                project_id=int(str(rule.cloud_project_id)),
                item_id=item.id,
                user_id=owner.id,
                values=values.model_copy(update={"version": item.version}),
                automation_context=context,
                instruction=rule.description or "",
            )
            return
        if external_loop_item_provider.is_external_item(db, run.task_id):
            current = external_loop_item_provider.get(db, run.task_id, owner.id)
            external_loop_item_provider.assign(
                db,
                run.task_id,
                owner.id,
                values.model_copy(update={"version": int(current.get("version") or 1)}),
                automation_context=context,
                instruction=rule.description or "",
            )
            return
        raise RuntimeError("Automatic processing Issue is unavailable")

    def _dispatch_generic_robot(
        self,
        db: Session,
        *,
        owner: User,
        rule: ProjectAutomationRule,
        run: ProjectAutomationRun,
        context: dict,
    ) -> None:
        if not run.task_id:
            raise RuntimeError("Automation task carrier is unavailable")
        from app.services.runtime_profiles import runtime_profile_service

        runtime_source = str(context.get("runtime_source") or "")
        profile = None
        profile_id = context.get("runtime_profile_id")
        runtime_subject_user_id = int(
            context.get("runtime_subject_user_id") or owner.id
        )
        if runtime_source == "fixed_profile" and isinstance(profile_id, str):
            profile = runtime_profile_service.require_owned(
                db, profile_id, runtime_subject_user_id
            )
        elif runtime_source in {"issue_creator", "runtime_user"}:
            profile = runtime_profile_service.resolve_project_default(
                db,
                str(rule.cloud_project_id),
                runtime_subject_user_id,
            )
        execution = loop_item_execution_service.enqueue_generic_robot(
            db,
            loop_item_id=str(run.task_id),
            cloud_project_id=str(rule.cloud_project_id),
            runtime_subject_user_id=runtime_subject_user_id,
            runtime_profile=profile,
            execution_device_id=str(context.get("execution_device_id") or "") or None,
            model=str(context.get("model") or "") or None,
            model_type=(
                str(context.get("model_type"))
                if context.get("model_type") is not None
                else None
            ),
            model_options=dict(context.get("model_options") or {}),
            assigner_user_id=owner.id,
            priority="medium",
            automation_context=context,
        )
        run.device_id = execution.execution_device_id
        run.status = (
            "waiting_runtime" if execution.status == "waiting_runtime" else "queued"
        )
        run.version += 1
        db.commit()

    @staticmethod
    def _run_instruction(rule: ProjectAutomationRule, run: ProjectAutomationRun) -> str:
        override = metadata(run).get("instruction_override")
        return (
            str(override)
            if isinstance(override, str)
            else (getattr(rule, "description", "") or "")
        )

    def _task_values(
        db: Session, *, project_id: str, task_id: str, user_id: int
    ) -> dict[str, object]:
        item = db.get(LoopItem, task_id)
        if item is not None and str(item.cloud_project_id) == str(project_id):
            values = dict(item.__dict__)
            item_metadata = metadata(item)
            group = item_metadata.get("collaboration_group")
            values["assignee_group_id"] = (
                str(group.get("id") or "") if isinstance(group, dict) else ""
            )
            values["assignee_group_name"] = (
                str(group.get("name") or "") if isinstance(group, dict) else ""
            )
            return values
        values = external_loop_item_provider.get(db, task_id, user_id)
        if str(values.get("cloud_project_id")) != str(project_id):
            raise RuntimeError("Automation task carrier is unavailable")
        return values

    @staticmethod
    def _bind_activity_to_execution(
        db: Session,
        *,
        run: ProjectAutomationRun,
        execution: LoopItemExecution,
    ) -> None:
        row = ProjectAutomationExecution._activity(db, run)
        if row is None:
            return
        activity_metadata = dict(row.metadata_json or {})
        activity_metadata.update(
            {
                "execution_id": execution.id,
                "executor_type": execution.executor_type,
                "run_status": "queued",
                "execution_device_id": execution.execution_device_id,
                "runtime_task_id": execution.runtime_task_id,
            }
        )
        row.metadata_json = activity_metadata
        row.runtime_device_id = execution.execution_device_id or ""
        row.runtime_task_id = execution.runtime_task_id or ""

    @staticmethod
    def _activity_payload(
        db: Session, run: ProjectAutomationRun
    ) -> dict[str, Any] | None:
        db.flush()
        row = ProjectAutomationExecution._activity(db, run)
        if row is None:
            return None
        return project_chat_service.to_view(row).model_dump(by_alias=True)

    def _commit_and_push_activity(
        self,
        db: Session,
        run: ProjectAutomationRun,
        *,
        push_activity: bool = True,
    ) -> None:
        payload = self._activity_payload(db, run) if push_activity else None
        db.commit()
        self._push_activity(payload)

    @staticmethod
    def _push_activity(payload: dict[str, Any] | None) -> None:
        if payload is not None:
            push_project_chat_message(payload)

    def _fail_run(self, db: Session, *, run_id: str, error: str) -> None:
        run = db.get(ProjectAutomationRun, run_id)
        if run is None or run.status in TERMINAL_RUN_STATUSES:
            return
        run.status = "failed"
        run.description = error[:2000]
        run.version += 1
        self.finish_activity(
            db,
            run=run,
            status_value="failed",
            content=error or "AI 托管任务派发失败。",
        )
        self._commit_and_push_activity(db, run)

    @staticmethod
    def finish_activity(
        db: Session,
        *,
        run: ProjectAutomationRun,
        status_value: str,
        content: str,
    ) -> None:
        row = ProjectAutomationExecution._activity(db, run)
        if row is None:
            return
        row.status = status_value
        row.message_type = "text"
        row.content = content
        activity_metadata = dict(row.metadata_json or {})
        activity_metadata["run_status"] = status_value
        if status_value == "failed":
            activity_metadata["error"] = content
        row.metadata_json = activity_metadata
        # Manager activity is an audit record. It must never become the
        # original task's execution state or advance the task workflow.

    @staticmethod
    def _activity(db: Session, run: ProjectAutomationRun) -> ProjectChatMessage | None:
        message_id = metadata(run).get("activity_message_id")
        if not isinstance(message_id, str) or not message_id:
            return None
        return (
            db.query(ProjectChatMessage)
            .filter(ProjectChatMessage.message_id == message_id)
            .one_or_none()
        )

    def _automation_context(
        self,
        db: Session,
        rule: ProjectAutomationRule,
        run: ProjectAutomationRun,
    ) -> dict:
        run_metadata = metadata(run)
        rule_metadata = metadata(rule)
        runtime = runtime_config(rule_metadata)
        runtime_source = str(runtime.get("source") or "agent_default")
        runtime_subject_user_id = int(rule.created_by_user_id or 0)
        runtime_profile_id = text(runtime.get("runtime_profile_id"))
        if runtime_source == "issue_creator" and run.task_id:
            task = self._task_values(
                db,
                project_id=str(rule.cloud_project_id),
                task_id=str(run.task_id),
                user_id=int(rule.created_by_user_id or 0),
            )
            runtime_subject_user_id = int(
                task.get("created_by_user_id") or runtime_subject_user_id
            )
        elif runtime_source == "runtime_user":
            runtime_subject_user_id = int(
                runtime.get("user_id") or runtime_subject_user_id
            )
        elif runtime_source == "fixed_profile" and runtime_profile_id:
            from app.models.delivery import RuntimeProfile

            profile = db.get(RuntimeProfile, runtime_profile_id)
            if profile is not None:
                runtime_subject_user_id = int(
                    profile.user_id or runtime_subject_user_id
                )
        workflow_config = run_metadata.get("workflow_execution_config")
        workflow_config = workflow_config if isinstance(workflow_config, dict) else {}
        configured_runtime_profile_id = workflow_config.get(
            "runtimeProfileId"
        ) or workflow_config.get("runtime_profile_id")
        if configured_runtime_profile_id:
            runtime_source = "fixed_profile"
            runtime_profile_id = str(configured_runtime_profile_id)
            from app.models.delivery import RuntimeProfile

            profile = db.get(RuntimeProfile, runtime_profile_id)
            if profile is not None:
                runtime_subject_user_id = int(
                    profile.user_id or runtime_subject_user_id
                )
        workspace_binding = workflow_config.get("workspaceBinding")
        if not isinstance(workspace_binding, dict):
            workspace_binding = workflow_config.get("workspace_binding")
        context = {
            "rule_id": str(rule.id),
            "run_id": str(run.id),
            "trigger": run_metadata.get("trigger") or run.source,
            "scheduled_for": run_metadata.get("scheduled_for"),
            "event": run_metadata.get("event") or {},
            "runtime_source": runtime_source,
            "runtime_profile_id": (configured_runtime_profile_id or runtime_profile_id),
            "runtime_subject_user_id": runtime_subject_user_id,
        }
        if workflow_config:
            from app.schemas.issue_workflow import WorkflowExecutionConfig

            execution_config = WorkflowExecutionConfig.model_validate(workflow_config)
            context.update(
                {
                    "agent_id": (
                        workflow_config.get("agentId")
                        or workflow_config.get("agent_id")
                    ),
                    "execution_device_id": (
                        workflow_config.get("executionDeviceId")
                        or workflow_config.get("execution_device_id")
                    ),
                    "model": workflow_config.get("model"),
                    "model_type": (
                        workflow_config.get("modelType")
                        or workflow_config.get("model_type")
                    ),
                    "model_options": (
                        workflow_config.get("modelOptions")
                        or workflow_config.get("model_options")
                        or {}
                    ),
                    "workspace_binding": workspace_binding,
                    **execution_config.runtime_request_options(),
                }
            )
        return context

    @staticmethod
    def _scheduled_for(run: ProjectAutomationRun) -> datetime:
        value = metadata(run).get("scheduled_for")
        if isinstance(value, str):
            try:
                return datetime.fromisoformat(value).replace(tzinfo=None)
            except ValueError:
                pass
        return run.created_at or utcnow()

    @staticmethod
    def _project_robot_execution_for_run(
        db: Session, run_id: str
    ) -> LoopItemExecution | None:
        run = db.get(ProjectAutomationRun, run_id)
        run_metadata = metadata(run) if run is not None else {}
        execution_floor_id = integer(run_metadata.get("retry_execution_floor_id")) or 0
        return (
            db.query(LoopItemExecution)
            .filter(
                LoopItemExecution.automation_run_id == run_id,
                LoopItemExecution.agent_id != "",
                LoopItemExecution.id > execution_floor_id,
            )
            .order_by(LoopItemExecution.id.desc())
            .first()
        )


project_automation_execution = ProjectAutomationExecution()


class ProjectAutomationProcessor:
    """Translate supported project events into ordinary automation runs."""

    def __init__(self, run_factory: AutomationRunFactory | None = None) -> None:
        self._run_factory = run_factory

    def _create_run(
        self,
        db: Session,
        rule: ProjectAutomationRule,
        trigger: str,
        scheduled_for: datetime,
        *,
        public_id: str | None = None,
    ) -> ProjectAutomationRun:
        if self._run_factory is not None:
            return self._run_factory(
                db,
                rule,
                trigger,
                scheduled_for,
                public_id=public_id,
            )
        from app.services.project_automations import project_automation_service

        return project_automation_service._create_run(
            db,
            rule,
            trigger,
            scheduled_for,
            public_id=public_id,
        )

    def matching_rules(
        self,
        db: Session,
        event: ProjectAutomationEvent,
        *,
        automation_id: str | None = None,
    ) -> list[ProjectAutomationRule]:
        """Return enabled rules that match one supported project event."""

        if not supported_event_type(event.event_type):
            return []
        query = db.query(ProjectAutomationRule).filter(
            ProjectAutomationRule.cloud_project_id == event.project_id,
            ProjectAutomationRule.status == "enabled",
            loop_datetime_is_unset(ProjectAutomationRule.deleted_at),
        )
        if automation_id:
            query = query.filter(ProjectAutomationRule.id == automation_id)
        project = db.get(CloudProject, event.project_id)
        if project is None:
            return []
        workflow = event.payload.get("workflow")
        deferred_automation_id = (
            str(workflow.get("ai_automation_rule_id") or "")
            if isinstance(workflow, dict) and workflow.get("advancement_policy") == "ai"
            else ""
        )
        candidate_rules = query.all()
        logger.info(
            "[ProjectAutomation] Evaluating event rules project=%s subject=%s "
            "event=%s previous_status=%s status=%s tags=%s candidates=%s",
            event.project_id,
            event.subject_id,
            event.event_type,
            event.payload.get("previous_status"),
            event.payload.get("status"),
            event.payload.get("tags"),
            [
                {
                    "id": str(rule.id),
                    "trigger_type": metadata(rule).get("trigger_type"),
                    "event_type": metadata(rule).get("event_type"),
                    "transition": (metadata(rule).get("event_config") or {}).get(
                        "transition"
                    ),
                    "tags": (metadata(rule).get("event_config") or {}).get("tags"),
                }
                for rule in candidate_rules
            ],
        )
        matches: list[ProjectAutomationRule] = []
        for rule in candidate_rules:
            if isinstance(event.payload.get("human_work"), dict):
                continue
            if deferred_automation_id and str(rule.id) == deferred_automation_id:
                continue
            rule_metadata = metadata(rule)
            if rule_metadata.get("trigger_type") != "event":
                continue
            if rule_metadata.get("event_type") != event.event_type:
                continue
            subscription_id = str(
                (rule_metadata.get("event_config") or {}).get("subscription_id") or ""
            )
            if subscription_id and subscription_id != str(event.subscription_id or ""):
                continue
            if self._matches(rule_metadata.get("event_config"), event, project):
                matches.append(rule)
        return matches

    async def retry(
        self,
        db: Session,
        *,
        run_id: str,
        requested_by_user_id: int,
    ) -> ProjectAutomationRun:
        """Re-dispatch the same failed processor record and board task."""

        run = (
            db.query(ProjectAutomationRun)
            .filter(ProjectAutomationRun.id == run_id)
            .populate_existing()
            .with_for_update()
            .one_or_none()
        )
        if run is None:
            raise RuntimeError("Automation run is unavailable")
        if run.status != "failed":
            raise AutomationRunNotRetryable(
                "Only a failed automation run can be retried"
            )
        active_execution = (
            db.query(LoopItemExecution.id)
            .filter(
                LoopItemExecution.automation_run_id == run_id,
                LoopItemExecution.status.in_(
                    {"pending_approval", "queued", "claimed", "running"}
                ),
            )
            .first()
        )
        if active_execution is not None:
            raise AutomationRunNotRetryable(
                "Automation run already has an active execution"
            )
        latest_execution_id = (
            db.query(LoopItemExecution.id)
            .filter(LoopItemExecution.automation_run_id == run_id)
            .order_by(LoopItemExecution.id.desc())
            .limit(1)
            .scalar()
            or 0
        )
        rule = db.get(ProjectAutomationRule, run.parent_id)
        if rule is None or str(rule.cloud_project_id) != str(run.cloud_project_id):
            raise RuntimeError("Automation rule is unavailable")

        run_metadata = metadata(run)
        run_metadata.pop("activity_message_id", None)
        run_metadata.update(
            {
                "retry_count": (integer(run_metadata.get("retry_count")) or 0) + 1,
                "retry_execution_floor_id": int(latest_execution_id),
                "last_retried_at": utcnow().isoformat(),
                "last_retried_by_user_id": requested_by_user_id,
            }
        )
        run.metadata_json = run_metadata
        run.status = "pending"
        run.description = ""
        run.completed_at = loop_unset_datetime_for_connection(
            db.connection(), "completed_at"
        )
        run.backend_task_id = 0
        run.assignee_agent_id = ""
        run.device_id = ""
        run.version += 1
        db.commit()
        db.refresh(run)

        await project_automation_execution.dispatch(db, rule, run)
        db.refresh(run)
        return run

    @trace_async(
        span_name="project_automation.event.process",
        tracer_name="backend.project_automation",
        extract_attributes=lambda self, db, event, **kwargs: {
            "automation.event.type": event.event_type,
            "project.id": str(event.project_id),
            "task.id": str(event.subject_id),
        },
    )
    async def process(
        self,
        db: Session,
        event: ProjectAutomationEvent,
        *,
        automation_id: str | None = None,
    ) -> int:
        return len(
            await self.process_with_runs(
                db,
                event,
                automation_id=automation_id,
            )
        )

    async def process_with_runs(
        self,
        db: Session,
        event: ProjectAutomationEvent,
        *,
        automation_id: str | None = None,
    ) -> list[ProjectAutomationRun]:
        if not supported_event_type(event.event_type):
            logger.info(
                "[ProjectAutomation] Ignoring unsupported event=%s", event.event_type
            )
            return []
        matching_rules = self.matching_rules(db, event, automation_id=automation_id)
        logger.info(
            "[ProjectAutomation] Event matched project=%s subject=%s event=%s "
            "requested_rule=%s matching_rule_ids=%s",
            event.project_id,
            event.subject_id,
            event.event_type,
            automation_id,
            [str(rule.id) for rule in matching_rules],
        )
        if (
            automation_id is None
            and matching_rules
            and event.event_type
            in {"task.created", "task.tag_added", "task.status_changed"}
        ):
            issue = (
                db.query(LoopItem)
                .filter(
                    LoopItem.id == event.subject_id,
                    LoopItem.cloud_project_id == event.project_id,
                    loop_datetime_is_unset(LoopItem.deleted_at),
                )
                .one_or_none()
            )
            issue_metadata = (
                issue.metadata_json
                if issue is not None and isinstance(issue.metadata_json, dict)
                else {}
            )
            workflow_binding = issue_metadata.get("workflow_automation")
            bound_rule_id = (
                str(workflow_binding.get("rule_id") or "")
                if isinstance(workflow_binding, dict)
                else ""
            )
            if bound_rule_id:
                matching_rules = [
                    rule for rule in matching_rules if str(rule.id) == bound_rule_id
                ]
            elif len(matching_rules) > 1:
                logger.info(
                    "[ProjectAutomation] Selection required project=%s subject=%s "
                    "candidates=%s",
                    event.project_id,
                    event.subject_id,
                    [str(rule.id) for rule in matching_rules],
                )
                return []

        runs: list[ProjectAutomationRun] = []
        for rule in matching_rules:
            run_public_id = self._event_run_public_id(event, rule)
            existing = self._event_run(db, run_public_id)
            if existing is not None and not self._is_unresolved_run(existing):
                runs.append(existing)
                continue
            run_event_payload = dict(event.payload)
            run = existing
            if run is None:
                try:
                    run = self._create_run(
                        db,
                        rule,
                        "event",
                        utcnow(),
                        public_id=run_public_id,
                    )
                except IntegrityError:
                    db.rollback()
                    run = self._event_run(db, run_public_id)
                    if run is None:
                        raise
                    if not self._is_unresolved_run(run):
                        runs.append(run)
                        continue
            else:
                run.status = "pending"
                run.description = ""
                run.completed_at = loop_unset_datetime_for_connection(
                    db.connection(),
                    "completed_at",
                )
                run.version += 1
            run_metadata = metadata(run)
            run_metadata["event"] = {
                "type": event.event_type,
                "source": event.source,
                "event_id": event.event_id,
                "subscription_id": event.subscription_id,
                "subject_type": event.subject_type,
                "subject_id": event.subject_id,
                "actor_user_id": event.actor_user_id,
                "payload": run_event_payload,
            }
            execution_config = run_event_payload.get("execution_config")
            if isinstance(execution_config, dict):
                run_metadata["workflow_execution_config"] = execution_config
            run.metadata_json = run_metadata
            target = self._execution_target(db, rule, event)
            if target["kind"] == "skipped":
                run.status = "skipped"
                run.description = str(target["reason"])
                run.completed_at = utcnow()
                run.metadata_json = {
                    **run_metadata,
                    "execution_target": target,
                }
                db.commit()
                runs.append(run)
                continue
            if target["kind"] == "continue_binding":
                binding = target["binding"]
                run.task_id = str(binding.loop_item_id)
                run.task_title = binding.task_title or ""
                run.device_id = binding.device_id
                run.backend_task_id = binding.backend_task_id
                run.metadata_json = {
                    **run_metadata,
                    "execution_target": {
                        "kind": "continue_binding",
                        "binding_id": str(binding.id),
                        "device_id": binding.device_id,
                        "runtime_task_id": binding.task_id,
                    },
                }
                db.commit()
                await self._continue_bound_task(db, rule, run, binding, event)
                runs.append(run)
                continue
            task = target.get("task")
            run.task_id = str(target.get("task_id") or getattr(task, "id", ""))
            run.task_title = str(
                target.get("task_title") or getattr(task, "title", "") or ""
            )
            run.metadata_json = {
                **run_metadata,
                "execution_target": {
                    "kind": target["kind"],
                    "task_id": run.task_id,
                },
            }
            db.commit()
            await project_automation_execution.dispatch(db, rule, run)
            runs.append(run)
        logger.info(
            "[ProjectAutomation] Event complete project=%s subject=%s dispatched=%s",
            event.project_id,
            event.subject_id,
            len(runs),
        )
        if runs:
            from app.tasks.robot_queue_tasks import consume_queues_background

            await consume_queues_background()
        return runs

    @staticmethod
    def _event_run(
        db: Session,
        public_id: str | None,
    ) -> ProjectAutomationRun | None:
        if not public_id:
            return None
        return (
            db.query(ProjectAutomationRun)
            .filter(ProjectAutomationRun.public_id == public_id)
            .one_or_none()
        )

    @staticmethod
    def _is_unresolved_run(run: ProjectAutomationRun) -> bool:
        if run.status != "skipped":
            return False
        target = metadata(run).get("execution_target")
        if not isinstance(target, dict) or target.get("kind") != "skipped":
            return False
        reason = str(target.get("reason") or run.description or "")
        return "binding" in reason.lower()

    def _execution_target(
        self,
        db: Session,
        rule: ProjectAutomationRule,
        event: ProjectAutomationEvent,
    ) -> dict[str, Any]:
        rule_metadata = metadata(rule)
        event_config = rule_metadata.get("event_config")
        event_config = event_config if isinstance(event_config, dict) else {}
        target = str(
            event_config.get("execution_target")
            or (
                "existing_issue"
                if event.event_type
                in {"task.created", "task.tag_added", "task.status_changed"}
                else "continue_binding"
            )
        )
        if target == "existing_issue":
            if event.event_type in {
                "task.created",
                "task.tag_added",
                "task.status_changed",
            }:
                return {
                    "kind": "existing_issue",
                    "task_id": event.subject_id,
                    "task_title": str(event.payload.get("title") or ""),
                }
            task = (
                db.query(LoopItem)
                .filter(
                    LoopItem.id == event.subject_id,
                    LoopItem.cloud_project_id == event.project_id,
                    loop_datetime_is_unset(LoopItem.deleted_at),
                )
                .one_or_none()
            )
            return (
                {"kind": "existing_issue", "task": task}
                if task is not None
                else {"kind": "skipped", "reason": "Event Issue was not found"}
            )
        if target == "continue_binding":
            subject = event.payload.get("subject")
            resolution = project_change_request_binding_service.resolve(
                db,
                project_id=event.project_id,
                subject=subject if isinstance(subject, dict) else {},
            )
            if resolution.binding is None:
                return {
                    "kind": "skipped",
                    "reason": resolution.reason
                    or "Change request binding was not found",
                }
            return {"kind": "continue_binding", "binding": resolution.binding}
        if target == "create_issue":
            project = db.get(CloudProject, event.project_id)
            owner = db.get(User, rule.created_by_user_id)
            if project is None or owner is None:
                return {
                    "kind": "skipped",
                    "reason": "Automation project or owner is unavailable",
                }
            payload = event.payload
            subject = payload.get("subject")
            subject = subject if isinstance(subject, dict) else {}
            title = str(
                payload.get("title")
                or subject.get("title")
                or f"{event.source}: {event.event_type}"
            )[:255]
            description = str(
                payload.get("description")
                or json.dumps(payload, ensure_ascii=False, indent=2, default=str)
            )
            created = loop_item_provider_router.create(
                db,
                project,
                owner,
                LoopItemCreate(
                    title=title,
                    description=description,
                    priority="medium",
                    tags=["automation", event.source],
                ),
                automation_context={
                    "trigger": "external_event",
                    "event_id": event.event_id,
                    "subscription_id": event.subscription_id,
                },
                assign_creator_if_unassigned=False,
            )
            task = created.internal_item or db.get(LoopItem, created.values.get("id"))
            if task is None:
                return {
                    "kind": "skipped",
                    "reason": "Automation Issue could not be created",
                }
            return {"kind": "create_issue", "task": task}
        return {"kind": "skipped", "reason": "Unsupported execution target"}

    async def _continue_bound_task(
        self,
        db: Session,
        rule: ProjectAutomationRule,
        run: ProjectAutomationRun,
        binding: LoopItemTaskBinding,
        event: ProjectAutomationEvent,
    ) -> None:
        run.status = "running"
        run.version += 1
        db.commit()
        subject = event.payload.get("subject")
        subject = subject if isinstance(subject, dict) else {}
        prompt = "\n\n".join(
            part
            for part in (
                rule.description or "",
                (
                    "External event context:\n"
                    f"- Type: {event.event_type}\n"
                    f"- Provider: {event.source}\n"
                    f"- Change request: {subject.get('url') or event.subject_id}\n"
                    f"- Payload: {json.dumps(event.payload, ensure_ascii=False, default=str)}"
                ),
            )
            if part
        )
        try:
            model_selection = self._bound_runtime_model_selection(db, binding)
            if model_selection is None:
                model_selection = self._rule_runtime_model_selection(rule)
            result = await runtime_work_service.send_runtime_message(
                db=db,
                user_id=int(binding.task_user_id),
                request=RuntimeSendRequest(
                    address=RuntimeTaskAddress(
                        deviceId=binding.device_id,
                        taskId=binding.task_id,
                    ),
                    message=prompt,
                    modelSelection=model_selection,
                ),
            )
            if not result.accepted:
                raise RuntimeError(result.error or "Runtime continuation was rejected")
            run.status = "succeeded"
            run.description = ""
        except Exception as exc:
            logger.exception(
                "[ProjectAutomation] Bound task continuation failed run=%s binding=%s",
                run.id,
                binding.id,
            )
            run.status = "failed"
            run.description = str(exc) or "Runtime continuation failed"
        run.completed_at = utcnow()
        run.version += 1
        db.commit()

    @staticmethod
    def _bound_runtime_model_selection(
        db: Session,
        binding: LoopItemTaskBinding,
    ) -> RuntimeModelSelection | None:
        """Preserve the model the bound Runtime task was created with."""

        execution = (
            db.query(LoopItemExecution)
            .filter(
                LoopItemExecution.loop_item_id == binding.loop_item_id,
                LoopItemExecution.runtime_device_id == binding.device_id,
                LoopItemExecution.runtime_task_id == binding.task_id,
            )
            .order_by(LoopItemExecution.id.desc())
            .first()
        )
        intent = execution.execution_intent if execution is not None else {}
        selection = intent.get("runtime_selection")
        selection = selection if isinstance(selection, dict) else {}
        model = str(selection.get("model") or "").strip()
        if not model:
            return None
        return RuntimeModelSelection(
            model_name=model,
            model_type=(
                str(selection["model_type"])
                if selection.get("model_type") is not None
                else None
            ),
            options=dict(selection.get("model_options") or {}),
        )

    @staticmethod
    def _rule_runtime_model_selection(
        rule: ProjectAutomationRule,
    ) -> RuntimeModelSelection | None:
        """Fall back to the model configured on the automation workflow node."""

        definition = ProjectAutomationExecution._workflow_definition(rule)
        if definition is None:
            return None
        for node in definition.nodes:
            config = node.execution_config
            if config is None or not config.model:
                continue
            return RuntimeModelSelection(
                model_name=config.model,
                model_type=config.model_type,
                options=dict(config.model_options or {}),
            )
        return None

    @staticmethod
    def _event_run_public_id(
        event: ProjectAutomationEvent,
        rule: ProjectAutomationRule,
    ) -> str | None:
        if not event.event_id:
            return None
        return hashlib.sha256(
            f"automation-event:{event.event_id}:{rule.id}".encode()
        ).hexdigest()[:36]

    @staticmethod
    def _matches(
        config: object,
        event: ProjectAutomationEvent,
        project: CloudProject,
    ) -> bool:
        if not isinstance(config, dict):
            return True
        sources = config.get("sources")
        if isinstance(sources, list) and sources and event.source not in sources:
            return False
        target_branches = config.get("target_branches")
        subject = event.payload.get("subject")
        subject = subject if isinstance(subject, dict) else {}
        if (
            isinstance(target_branches, list)
            and target_branches
            and subject.get("base_branch") not in target_branches
        ):
            return False
        repositories = config.get("repositories")
        if (
            isinstance(repositories, list)
            and repositories
            and subject.get("repository") not in repositories
        ):
            return False
        if event.event_type == "task.status_changed":
            transition = config.get("transition")
            if transition not in {"entered_processing", "any"}:
                return False
            previous_status = event.payload.get("previous_status")
            current_status = event.payload.get("status")
            if not isinstance(previous_status, str) or not isinstance(
                current_status, str
            ):
                return False
            if previous_status == current_status:
                return False
            if (
                transition == "entered_processing"
                and not project_status_transition(
                    project,
                    previous_status=previous_status,
                    current_status=current_status,
                ).entered_processing
            ):
                return False
        expected_priorities = config.get("priorities")
        if (
            isinstance(expected_priorities, list)
            and expected_priorities
            and event.payload.get("priority") not in expected_priorities
        ):
            return False
        expected_tags = config.get("tags")
        actual_tags = (
            event.payload.get("added_tags")
            if event.event_type == "task.tag_added"
            else event.payload.get("tags")
        )
        if isinstance(expected_tags, list) and expected_tags:
            return bool(
                set(expected_tags).intersection(
                    actual_tags if isinstance(actual_tags, list) else []
                )
            )
        return True
