# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Execution orchestration and event processing for project automations."""

from __future__ import annotations

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
    loop_unset_datetime_for_connection,
)
from app.models.loop_item_execution import LoopItemExecution
from app.models.project_chat_message import ProjectChatMessage
from app.models.user import User
from app.schemas.delivery import LoopItemCreate
from app.schemas.project_chat import LoopItemAssign
from app.services.cloud_projects.service import cloud_project_service
from app.services.loop_item_executions.service import loop_item_execution_service
from app.services.loop_items.external_provider import external_loop_item_provider
from app.services.loop_items.provider_router import loop_item_provider_router
from app.services.loop_items.service import loop_item_service
from app.services.project_automation_domain import (
    TERMINAL_RUN_STATUSES,
    ProjectAutomationEvent,
    assignment_mode,
    integer,
    manager_type,
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
            "automation.assignment.mode": assignment_mode(metadata(rule)),
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
            configured_mode = assignment_mode(metadata(rule))
            if configured_mode == "manual":
                self._assign_project_robot(
                    db,
                    owner=owner,
                    rule=rule,
                    run=run,
                    agent_id=rule.assignee_agent_id,
                    context=context,
                    instruction=rule.description or "",
                )
            else:
                configured_manager = manager_type(metadata(rule))
                activity = self._create_manager_activity(
                    db,
                    rule=rule,
                    run=run,
                    configured_manager=configured_manager,
                )
                context["activity_message_id"] = activity.message_id
                if configured_manager == "custom":
                    self._dispatch_custom_manager(
                        db, owner=owner, rule=rule, run=run, context=context
                    )
                elif configured_manager == "wegent":
                    await self._dispatch_wegent_manager(
                        db,
                        owner=owner,
                        project=project,
                        rule=rule,
                        run=run,
                        activity=activity,
                        context=context,
                    )
                else:
                    raise RuntimeError("AI manager configuration is incomplete")
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
                instruction=instruction,
            )
        elif external_loop_item_provider.is_external_item(db, run.task_id):
            external_loop_item_provider.assign(
                db,
                run.task_id,
                owner.id,
                LoopItemAssign(assignee_type="agent", assignee_id=agent.id, version=1),
                automation_context=context,
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
        logger.info(
            "[ProjectAutomation] Queued project robot run=%s execution=%s device=%s",
            run.id,
            execution.id,
            execution.execution_device_id,
        )

    def _dispatch_custom_manager(
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
            raise RuntimeError("Custom AI manager configuration is incomplete")
        execution = loop_item_execution_service.enqueue_automation_manager(
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
            "[ProjectAutomation] Queued custom manager run=%s execution=%s device=%s",
            run.id,
            execution.id,
            device_id,
        )

    async def _dispatch_wegent_manager(
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
        return (
            "你是这个看板的 AI 分派调度员，不是任务执行者。必须先通过 wework_space "
            "工具读取当前项目、原始任务，以及项目成员和项目机器人的能力说明；再根据"
            "任务内容和下面的调度要求选择最合适的人员或机器人，并通过工具直接完成"
            "分派。不要自己执行原始任务，不要创建替代任务，也不要只在回复中建议人选。"
            "如果没有合适人选，保持任务未分配并说明原因。工具调用完成后，最终回复只"
            "需简要记录已分配给谁以及判断依据；最终回复不参与分派，也不要求 JSON。\n\n"
            f"当前项目 ID：{project.id}\n"
            f"当前任务 ID：{run.task_id or ''}\n"
            f"调度要求：\n{rule.description or ''}"
        )

    def _create_manager_activity(
        self,
        db: Session,
        *,
        rule: ProjectAutomationRule,
        run: ProjectAutomationRun,
        configured_manager: str | None,
    ) -> ProjectChatMessage:
        rule_metadata = metadata(rule)
        manager_ref = str(rule.id)
        model = ""
        if configured_manager == "custom":
            sender_name = "自定义 AI 调度员"
            sender_id = f"automation_manager:{rule.id}"
            model = text(rule_metadata.get("model")) or ""
        elif configured_manager == "wegent":
            team = wegent_team(
                db,
                int(rule.created_by_user_id or 0),
                integer(rule_metadata.get("wegent_team_id")),
            )
            sender_name = str(team.name or "Wegent 智能体")
            sender_id = f"wegent_team:{team.id}"
            manager_ref = str(team.id)
        else:
            raise RuntimeError("AI manager configuration is incomplete")

        message_id = str(uuid.uuid7()) if hasattr(uuid, "uuid7") else str(uuid.uuid4())
        message_metadata = {
            "kind": "project_automation_run",
            "automation_rule_id": str(rule.id),
            "automation_run_id": str(run.id),
            "automation_rule_name": rule.title or "AI managed automation",
            "assignment_mode": "ai_managed",
            "manager_type": configured_manager,
            "manager_ref": manager_ref,
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
            agent_id="",
            runtime_device_id="",
            runtime_task_id="",
            status="pending",
        )
        db.add(row)
        db.flush()
        run_metadata = metadata(run)
        run_metadata["activity_message_id"] = message_id
        run.metadata_json = run_metadata
        db.commit()
        db.refresh(row)
        push_project_chat_message(
            project_chat_service.to_view(row).model_dump(by_alias=True)
        )
        return row

    def assign_from_manager(
        self,
        db: Session,
        *,
        run_id: str,
        user_id: int,
        project_id: str,
        task_id: str,
        assignee_type: str,
        assignee_id: str,
    ) -> LoopItem | dict[str, object]:
        """Apply an MCP manager assignment through the shipped task path."""

        run = (
            db.query(ProjectAutomationRun)
            .filter(ProjectAutomationRun.id == run_id)
            .populate_existing()
            .with_for_update()
            .one_or_none()
        )
        if run is None:
            raise RuntimeError("AI-managed automation run is not active")
        rule = db.get(ProjectAutomationRule, run.parent_id)
        owner = db.get(User, run.created_by_user_id)
        if rule is None or owner is None:
            raise RuntimeError("Automation rule or owner is unavailable")
        if owner.id != user_id:
            raise RuntimeError("AI manager does not own this automation run")
        rule_metadata = metadata(rule)
        if assignment_mode(rule_metadata) != "ai_managed":
            raise RuntimeError("Automation is no longer AI-managed")
        if str(rule.cloud_project_id) != str(project_id):
            raise RuntimeError("AI manager project does not match the automation run")
        if str(run.task_id or "") != str(task_id):
            raise RuntimeError("AI manager task does not match the automation run")
        if assignee_type not in {"user", "agent"}:
            raise RuntimeError("AI manager assignee type must be user or agent")
        robot_execution = self._project_robot_execution_for_run(db, run_id)
        current_task = self._task_values(
            db, project_id=project_id, task_id=task_id, user_id=user_id
        )
        current_agent_id = str(current_task.get("assignee_agent_id") or "")
        current_user_id = str(current_task.get("assignee_user_id") or "")
        activity = self._activity(db, run)
        activity_metadata = dict(activity.metadata_json or {}) if activity else {}
        selected_type = str(activity_metadata.get("selected_assignee_type") or "")
        selected_id = str(activity_metadata.get("selected_assignee_id") or "")
        if selected_type or selected_id:
            if selected_type != assignee_type or selected_id != assignee_id:
                raise RuntimeError("AI manager has already selected another assignee")
            task_matches = (
                assignee_type == "agent" and current_agent_id == assignee_id
            ) or (assignee_type == "user" and current_user_id == assignee_id)
            if not task_matches:
                raise RuntimeError("AI manager assignment no longer matches the task")
            if assignee_type == "agent" and robot_execution is None:
                raise RuntimeError("AI manager robot execution is unavailable")
            return current_task
        if run.status in TERMINAL_RUN_STATUSES:
            raise RuntimeError("AI-managed automation run is not active")
        if robot_execution is not None:
            raise RuntimeError("AI manager has already assigned this task to a robot")

        context = self._automation_context(rule, run)
        if assignee_type == "agent":
            self._assign_project_robot(
                db,
                owner=owner,
                rule=rule,
                run=run,
                agent_id=assignee_id,
                context=context,
                instruction="",
            )
        else:
            member_ids = {
                str(member["user_id"])
                for member in cloud_project_service.list_members(
                    db, int(project_id), owner.id
                )
            }
            if assignee_id not in member_ids:
                raise RuntimeError("AI manager selected an unavailable project member")
            item = db.get(LoopItem, task_id)
            if item is not None:
                loop_item_service.assign(
                    db,
                    project_id=int(project_id),
                    item_id=item.id,
                    user_id=owner.id,
                    values=LoopItemAssign(
                        assignee_type="user",
                        assignee_id=assignee_id,
                        version=item.version,
                    ),
                    automation_context=context,
                    instruction="",
                )
            elif external_loop_item_provider.is_external_item(db, task_id):
                current = external_loop_item_provider.get(db, task_id, owner.id)
                external_loop_item_provider.assign(
                    db,
                    task_id,
                    owner.id,
                    LoopItemAssign(
                        assignee_type="user",
                        assignee_id=assignee_id,
                        version=int(current.get("version") or 0),
                    ),
                    automation_context=context,
                    instruction="",
                )
            else:
                raise RuntimeError("Automation task carrier is unavailable")
            run.assignee_agent_id = ""

        activity = self._activity(db, run)
        if activity is not None:
            activity_metadata = dict(activity.metadata_json or {})
            activity.metadata_json = {
                **activity_metadata,
                "selected_assignee_type": assignee_type,
                "selected_assignee_id": assignee_id,
            }
            db.commit()
        return self._task_values(
            db, project_id=project_id, task_id=task_id, user_id=user_id
        )

    def has_recorded_manager_assignment(self, db: Session, *, run_id: str) -> bool:
        """Return whether the manager durably completed its assignment action."""

        run = db.get(ProjectAutomationRun, run_id)
        if run is None:
            return False
        activity = self._activity(db, run)
        metadata = dict(activity.metadata_json or {}) if activity else {}
        selected_type = str(metadata.get("selected_assignee_type") or "")
        selected_id = str(metadata.get("selected_assignee_id") or "")
        if selected_type == "user":
            return bool(selected_id)
        if selected_type == "agent" and selected_id:
            execution = self._project_robot_execution_for_run(db, run_id)
            return execution is not None and execution.agent_id == selected_id
        return False

    def finalize_manager_result(
        self,
        db: Session,
        *,
        run_id: str,
        content: str | None,
        backend_task_id: int | None = None,
        activity_message_id: str | None = None,
        push_activity: bool = True,
    ) -> bool:
        """Project manager output as audit text; assignment state is authoritative."""

        run = db.get(ProjectAutomationRun, run_id)
        if run is None:
            return False
        rule = db.get(ProjectAutomationRule, run.parent_id)
        owner = db.get(User, run.created_by_user_id)
        if rule is None or owner is None:
            return False
        task = self._task_values(
            db,
            project_id=str(rule.cloud_project_id),
            task_id=str(run.task_id or ""),
            user_id=owner.id,
        )
        assignee_agent_id = task.get("assignee_agent_id")
        assignee_user_id = task.get("assignee_user_id")
        activity = self._activity(db, run)
        if activity is None and activity_message_id:
            activity = (
                db.query(ProjectChatMessage)
                .filter(ProjectChatMessage.message_id == activity_message_id)
                .one_or_none()
            )
        activity_metadata = dict(activity.metadata_json or {}) if activity else {}
        selected_type = str(activity_metadata.get("selected_assignee_type") or "")
        selected_id = str(activity_metadata.get("selected_assignee_id") or "")
        selected_agent_id = (
            selected_id
            if selected_type == "agent" and str(assignee_agent_id or "") == selected_id
            else ""
        )
        selected_user_id = (
            selected_id
            if selected_type == "user" and str(assignee_user_id or "") == selected_id
            else ""
        )
        if (selected_type or selected_id) and not (
            selected_agent_id or selected_user_id
        ):
            raise RuntimeError("AI manager assignment no longer matches the task")
        projection_already_completed = bool(
            activity is not None
            and activity.status == "completed"
            and (
                backend_task_id is None
                or activity_metadata.get("backend_task_id") == backend_task_id
            )
        )
        audit = (content or "").strip()
        if selected_agent_id:
            if self._project_robot_execution_for_run(db, run_id) is None:
                raise RuntimeError(
                    "AI manager assignment did not create a robot execution"
                )
        run_changed = False
        if selected_agent_id or selected_user_id:
            if run.status not in TERMINAL_RUN_STATUSES:
                run.status = "succeeded"
                run.completed_at = utcnow()
                run.version += 1
                run_changed = True
        elif run.status not in TERMINAL_RUN_STATUSES:
            run.status = "skipped"
            run.completed_at = utcnow()
            run.version += 1
            run_changed = True

        if backend_task_id is not None and run.backend_task_id != backend_task_id:
            run.backend_task_id = backend_task_id
            run_changed = True
        if projection_already_completed:
            if run_changed:
                db.commit()
                if push_activity:
                    self._push_activity(db, run)
            return run_changed
        if activity is not None:
            activity.status = "completed"
            activity.message_type = "text"
            activity.content = audit or (
                "AI 调度员已完成分派。"
                if selected_agent_id or selected_user_id
                else "AI 调度员未找到合适的分派对象。"
            )
            activity.metadata_json = {
                **activity_metadata,
                "run_status": "completed",
                **(
                    {"backend_task_id": backend_task_id}
                    if backend_task_id is not None
                    else {}
                ),
            }
        db.commit()
        if push_activity:
            self._push_activity(db, run)
        return True

    @staticmethod
    def _task_values(
        db: Session, *, project_id: str, task_id: str, user_id: int
    ) -> dict[str, object]:
        item = db.get(LoopItem, task_id)
        if item is not None and str(item.cloud_project_id) == str(project_id):
            return dict(item.__dict__)
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
    ) -> ProjectAutomationRun:
        if self._run_factory is not None:
            return self._run_factory(db, rule, trigger, scheduled_for)
        from app.services.project_automations import project_automation_service

        return project_automation_service._create_run(db, rule, trigger, scheduled_for)

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
            event_title = event.payload.get("title")
            run.task_title = str(event_title) if event_title else ""
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
