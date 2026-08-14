# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Execution orchestration and event processing for project automations."""

from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime, timezone
from typing import Protocol
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.delivery import (
    CloudProject,
    LoopItem,
    ProjectAutomationRule,
    ProjectAutomationRun,
    ProjectChatAgent,
    loop_datetime_is_unset,
)
from app.models.loop_item_execution import LoopItemExecution
from app.models.project_chat_message import ProjectChatMessage
from app.models.user import User
from app.schemas.delivery import LoopItemCreate
from app.schemas.project_chat import LoopItemAssign
from app.services.loop_item_executions.service import loop_item_execution_service
from app.services.loop_items.external_provider import external_loop_item_provider
from app.services.loop_items.provider_router import loop_item_provider_router
from app.services.loop_items.service import loop_item_service
from app.services.project_automation_domain import (
    TERMINAL_RUN_STATUSES,
    ProjectAutomationEvent,
    executor_type,
    integer,
    metadata,
    project_agent,
    runnable_wegent_team,
    text,
    utcnow,
    wegent_team,
)
from app.services.project_chat.push import push_project_chat_message
from app.services.project_chat.service import project_chat_service
from shared.telemetry.decorators import trace_async

logger = logging.getLogger(__name__)


class AutomationRunFactory(Protocol):
    def __call__(
        self,
        db: Session,
        rule: ProjectAutomationRule,
        trigger: str,
        scheduled_for: datetime,
        *,
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
            "automation.executor.type": executor_type(metadata(rule)),
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
            self._ensure_run_task(db, project=project, owner=owner, rule=rule, run=run)
            context = self._automation_context(rule, run)
            configured_executor = executor_type(metadata(rule))
            activity = self._create_activity(
                db,
                rule=rule,
                run=run,
                configured_executor=configured_executor,
            )
            context["activity_message_id"] = activity.message_id
            if configured_executor == "project_robot":
                self._dispatch_project_robot(
                    db, owner=owner, rule=rule, run=run, context=context
                )
            elif configured_executor == "custom":
                self._dispatch_custom(
                    db, owner=owner, rule=rule, run=run, context=context
                )
            else:
                await self._dispatch_wegent(
                    db,
                    owner=owner,
                    project=project,
                    rule=rule,
                    run=run,
                    activity=activity,
                    context=context,
                )
        except Exception as exc:
            db.rollback()
            logger.exception(
                "[ProjectAutomation] Dispatch failed rule=%s run=%s",
                rule.id,
                run.id,
            )
            self._fail_run(db, run_id=str(run.id), error=str(exc) or "Dispatch failed")

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
        context = self._automation_context(rule, run)
        routed = loop_item_provider_router.create(
            db,
            project,
            owner,
            LoopItemCreate(
                title=f"{rule.title} · {local_time:%Y-%m-%d %H:%M}",
                description=rule.description or "",
                priority="medium",
                tags=["automation"],
            ),
            automation_context=context,
            instruction=rule.description or "",
            assign_creator_if_unassigned=False,
        )
        item_id = routed.values.get("id")
        if not item_id:
            raise RuntimeError("Automation task carrier was not created")
        run.task_id = str(item_id)
        run.version += 1
        db.commit()
        db.refresh(run)

    def _dispatch_project_robot(
        self,
        db: Session,
        *,
        owner: User,
        rule: ProjectAutomationRule,
        run: ProjectAutomationRun,
        context: dict,
    ) -> None:
        agent = project_agent(db, str(rule.cloud_project_id), rule.assignee_agent_id)
        if not run.task_id:
            raise RuntimeError("Automation task carrier is unavailable")
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
                automation_context=context,
                instruction=rule.description or "",
            )
        elif external_loop_item_provider.is_external_item(db, run.task_id):
            external_loop_item_provider.assign(
                db,
                run.task_id,
                owner.id,
                LoopItemAssign(assignee_type="agent", assignee_id=agent.id, version=1),
                automation_context=context,
                instruction=rule.description or "",
            )
        else:
            raise RuntimeError("Automation task carrier is unavailable")
        execution = self._execution_for_run(db, str(run.id))
        if execution is None:
            raise RuntimeError("Project robot execution was not created")
        run.assignee_agent_id = agent.id
        run.device_id = execution.execution_device_id
        run.status = "queued"
        run.version += 1
        self._bind_activity_to_execution(db, run=run, execution=execution)
        db.commit()
        self._push_activity(db, run)
        logger.info(
            "[ProjectAutomation] Queued project robot run=%s execution=%s device=%s",
            run.id,
            execution.id,
            execution.execution_device_id,
        )

    def _dispatch_custom(
        self,
        db: Session,
        *,
        owner: User,
        rule: ProjectAutomationRule,
        run: ProjectAutomationRun,
        context: dict,
    ) -> None:
        rule_metadata = metadata(rule)
        model = text(rule_metadata.get("model"))
        environment = text(rule_metadata.get("execution_environment"))
        device_id = text(rule_metadata.get("execution_device_id"))
        if not model or not environment or not device_id or not run.task_id:
            raise RuntimeError("Custom Wework execution configuration is incomplete")
        execution = loop_item_execution_service.enqueue_custom(
            db,
            loop_item_id=str(run.task_id),
            cloud_project_id=str(rule.cloud_project_id),
            owner_user_id=owner.id,
            assigner_user_id=owner.id,
            environment=environment,
            execution_device_id=device_id,
            priority="medium",
            automation_context=context,
        )
        run.device_id = device_id
        run.status = "queued"
        run.version += 1
        self._bind_activity_to_execution(db, run=run, execution=execution)
        db.commit()
        self._push_activity(db, run)
        logger.info(
            "[ProjectAutomation] Queued custom Wework run=%s execution=%s device=%s",
            run.id,
            execution.id,
            device_id,
        )

    async def _dispatch_wegent(
        self,
        db: Session,
        *,
        owner: User,
        project: CloudProject,
        rule: ProjectAutomationRule,
        run: ProjectAutomationRun,
        activity: ProjectChatMessage,
        context: dict,
    ) -> None:
        team = runnable_wegent_team(
            db,
            owner.id,
            integer(metadata(rule).get("wegent_team_id")),
        )
        if not run.task_id:
            raise RuntimeError("Automation task carrier is unavailable")
        prompt = self._managed_prompt(
            db,
            owner=owner,
            project=project,
            rule=rule,
            run=run,
            context=context,
        )
        from app.services.project_automation_managed_execution import (
            project_automation_managed_execution_service,
        )

        handle = await project_automation_managed_execution_service.dispatch(
            db=db,
            owner=owner,
            team=team,
            prompt=prompt,
            title=rule.title or "AI managed automation",
            project_id=str(project.id),
            loop_item_id=str(run.task_id),
            automation_run_id=str(run.id),
            project_chat_message_id=activity.message_id,
        )
        db.expire_all()
        refreshed_run = db.get(ProjectAutomationRun, run.id)
        refreshed_activity = (
            db.query(ProjectChatMessage)
            .filter(ProjectChatMessage.message_id == activity.message_id)
            .one()
        )
        if refreshed_run is None:
            raise RuntimeError("Automation run disappeared after dispatch")
        refreshed_run.backend_task_id = handle.task_id
        if refreshed_run.status not in TERMINAL_RUN_STATUSES | {"running"}:
            refreshed_run.status = "queued"
            refreshed_run.version += 1
        activity_metadata = dict(refreshed_activity.metadata_json or {})
        activity_metadata.update(
            {
                "backend_task_id": handle.task_id,
                "backend_subtask_id": handle.subtask_id,
                "execution_url": (
                    f"{settings.FRONTEND_URL.rstrip('/')}/tasks?taskId={handle.task_id}"
                ),
                "run_status": (
                    refreshed_activity.status
                    if refreshed_activity.status in {"completed", "failed", "cancelled"}
                    else refreshed_run.status
                ),
            }
        )
        refreshed_activity.metadata_json = activity_metadata
        db.commit()
        db.refresh(refreshed_activity)
        push_project_chat_message(
            project_chat_service.to_view(refreshed_activity).model_dump(by_alias=True)
        )
        logger.info(
            "[ProjectAutomation] Queued Wegent run=%s backend_task=%s team=%s",
            refreshed_run.id,
            handle.task_id,
            team.id,
        )

    @staticmethod
    def _managed_prompt(
        db: Session,
        *,
        owner: User,
        project: CloudProject,
        rule: ProjectAutomationRule,
        run: ProjectAutomationRun,
        context: dict,
    ) -> str:
        task = loop_item_execution_service.resolve_task_context(
            db,
            execution=LoopItemExecution(
                loop_item_id=str(run.task_id or ""),
                cloud_project_id=str(project.id),
            ),
            user_id=owner.id,
        )
        if task is None:
            raise RuntimeError("Automation task context is unavailable")
        project_context = {
            "id": str(project.id),
            "key": project.project_key,
            "name": project.title or project.name or "",
            "description": project.description or "",
            "task_provider": project.task_provider,
        }
        return (
            f"{rule.description or ''}\n\n"
            "以下是本次看板自动化的确定上下文。请完成要求，并在需要读取最新状态或"
            "分派任务时使用 wework-space MCP；不要猜测缺失信息。\n"
            f"<wework_project>{json.dumps(project_context, ensure_ascii=False)}</wework_project>\n"
            f"<current_task>{json.dumps(task.to_context(), ensure_ascii=False)}</current_task>\n"
            f"<automation_trigger>{json.dumps(context, ensure_ascii=False, default=str)}</automation_trigger>"
        )

    def _create_activity(
        self,
        db: Session,
        *,
        rule: ProjectAutomationRule,
        run: ProjectAutomationRun,
        configured_executor: str,
    ) -> ProjectChatMessage:
        rule_metadata = metadata(rule)
        agent: ProjectChatAgent | None = None
        executor_ref = str(rule.id)
        model = ""
        if configured_executor == "project_robot":
            agent = project_agent(
                db, str(rule.cloud_project_id), rule.assignee_agent_id
            )
            sender_name = str(agent.title or agent.name or "AI")
            sender_id = agent.id
            executor_ref = agent.id
        elif configured_executor == "custom":
            sender_name = "AI 托管"
            sender_id = f"inline_custom:{rule.id}"
            model = text(rule_metadata.get("model")) or ""
        else:
            team = wegent_team(
                db,
                int(rule.created_by_user_id or 0),
                integer(rule_metadata.get("wegent_team_id")),
            )
            sender_name = str(team.name or "Wegent 机器人")
            sender_id = f"wegent_team:{team.id}"
            executor_ref = str(team.id)

        message_id = str(uuid.uuid7()) if hasattr(uuid, "uuid7") else str(uuid.uuid4())
        message_metadata = {
            "kind": "project_automation_run",
            "automation_rule_id": str(rule.id),
            "automation_run_id": str(run.id),
            "automation_rule_name": rule.title or "AI managed automation",
            "executor_type": configured_executor,
            "executor_ref": executor_ref,
            "run_id": str(run.id),
            "run_status": "queued",
        }
        if model:
            message_metadata["model"] = model
        row = ProjectChatMessage(
            message_id=message_id,
            client_message_id=message_id,
            project_id=str(rule.cloud_project_id),
            task_id=str(run.task_id or ""),
            sender_type="agent",
            sender_id=sender_id,
            sender_name=sender_name,
            message_type="agent_status",
            content="",
            metadata_json=message_metadata,
            agent_id=agent.id if agent else "",
            runtime_device_id="",
            runtime_task_id="",
            status="pending",
        )
        db.add(row)
        db.flush()
        run_metadata = metadata(run)
        run_metadata["activity_message_id"] = message_id
        run.metadata_json = run_metadata
        project_chat_service._set_task_ai_state(
            db,
            row=row,
            trigger=None,
            agent=agent,
            status_value="queued",
            prompt=rule.description or "",
            user_id=rule.created_by_user_id,
        )
        db.commit()
        db.refresh(row)
        push_project_chat_message(
            project_chat_service.to_view(row).model_dump(by_alias=True)
        )
        return row

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
                "run_status": "queued",
                "execution_device_id": execution.execution_device_id,
            }
        )
        row.metadata_json = activity_metadata

    @staticmethod
    def _push_activity(db: Session, run: ProjectAutomationRun) -> None:
        row = ProjectAutomationExecution._activity(db, run)
        if row is not None:
            push_project_chat_message(
                project_chat_service.to_view(row).model_dump(by_alias=True)
            )

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
        db.commit()
        self._push_activity(db, run)

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
        project_chat_service._set_task_ai_state(
            db,
            row=row,
            trigger=None,
            agent=None,
            status_value=status_value,
            error=content if status_value == "failed" else None,
        )

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

    @staticmethod
    def _automation_context(
        rule: ProjectAutomationRule, run: ProjectAutomationRun
    ) -> dict:
        run_metadata = metadata(run)
        return {
            "rule_id": str(rule.id),
            "run_id": str(run.id),
            "trigger": run_metadata.get("trigger") or run.source,
            "scheduled_for": run_metadata.get("scheduled_for"),
            "event": run_metadata.get("event") or {},
        }

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
    def _execution_for_run(db: Session, run_id: str) -> LoopItemExecution | None:
        return (
            db.query(LoopItemExecution)
            .filter(LoopItemExecution.automation_run_id == run_id)
            .one_or_none()
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
    ) -> ProjectAutomationRun:
        if self._run_factory is not None:
            return self._run_factory(db, rule, trigger, scheduled_for)
        from app.services.project_automations import project_automation_service

        return project_automation_service._create_run(db, rule, trigger, scheduled_for)

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
        if event.event_type != "task.created":
            logger.info(
                "[ProjectAutomation] Ignoring unsupported event=%s", event.event_type
            )
            return 0
        query = db.query(ProjectAutomationRule).filter(
            ProjectAutomationRule.cloud_project_id == event.project_id,
            ProjectAutomationRule.status == "enabled",
            loop_datetime_is_unset(ProjectAutomationRule.deleted_at),
        )
        if automation_id:
            query = query.filter(ProjectAutomationRule.id == automation_id)
        dispatched = 0
        for rule in query.all():
            rule_metadata = metadata(rule)
            if rule_metadata.get("trigger_type") != "event":
                continue
            if rule_metadata.get("event_type") != event.event_type:
                continue
            if not self._matches(rule_metadata.get("event_config"), event):
                continue
            run = self._create_run(db, rule, "event", utcnow())
            run.task_id = event.subject_id
            run_metadata = metadata(run)
            run_metadata["event"] = {
                "type": event.event_type,
                "source": event.source,
                "subject_id": event.subject_id,
                "actor_user_id": event.actor_user_id,
                "payload": event.payload,
            }
            run.metadata_json = run_metadata
            db.commit()
            await project_automation_execution.dispatch(db, rule, run)
            dispatched += 1
        logger.info(
            "[ProjectAutomation] Event complete project=%s subject=%s dispatched=%s",
            event.project_id,
            event.subject_id,
            dispatched,
        )
        return dispatched

    @staticmethod
    def _matches(config: object, event: ProjectAutomationEvent) -> bool:
        if not isinstance(config, dict):
            return True
        sources = config.get("sources")
        if isinstance(sources, list) and sources and event.source not in sources:
            return False
        for field in ("statuses", "priorities"):
            expected = config.get(field)
            payload_key = "status" if field == "statuses" else "priority"
            if (
                isinstance(expected, list)
                and expected
                and event.payload.get(payload_key) not in expected
            ):
                return False
        expected_tags = config.get("tags")
        actual_tags = event.payload.get("tags")
        if isinstance(expected_tags, list) and expected_tags:
            return bool(
                set(expected_tags).intersection(
                    actual_tags if isinstance(actual_tags, list) else []
                )
            )
        return True
