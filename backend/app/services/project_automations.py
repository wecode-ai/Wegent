# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Project-scoped automation rules and scheduled board runs."""

from __future__ import annotations

import json
import logging
import secrets
from dataclasses import dataclass
from datetime import datetime, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from croniter import croniter
from fastapi import HTTPException, status
from sqlalchemy.orm import Session, aliased

from app.models.delivery import (
    LoopItem,
    ProjectAutomationRule,
    ProjectAutomationRun,
    ProjectChatAgent,
    loop_datetime_is_unset,
    loop_datetime_value_is_unset,
    loop_unset_datetime_for_connection,
)
from app.models.kind import Kind
from app.models.loop_item_execution import LoopItemExecution
from app.models.user import User
from app.schemas.base_role import BaseRole
from app.schemas.delivery import LoopItemCreate
from app.schemas.project_automation import (
    ProjectAutomationCreate,
    ProjectAutomationUpdate,
)
from app.schemas.project_chat import LoopItemAssign
from app.services.chat.config import extract_and_process_model_config
from app.services.cloud_projects.access import require_cloud_project_role
from app.services.device_service import device_service
from app.services.loop_item_executions.service import loop_item_execution_service
from app.services.loop_items.external_provider import external_loop_item_provider
from app.services.loop_items.service import loop_item_service
from app.services.project_chat.service import bot_config
from app.services.simple_chat import simple_chat_service
from shared.utils.crypto import encrypt_sensitive_data_with_embedded_iv

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class ProjectAutomationEvent:
    event_type: str
    project_id: str
    subject_id: str
    source: str
    actor_user_id: int | None
    payload: dict


def utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _utc_aware(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _metadata(row: object) -> dict:
    value = getattr(row, "metadata_json", None)
    return dict(value) if isinstance(value, dict) else {}


def _next_run(expression: str, timezone_name: str, after: datetime) -> datetime:
    try:
        tz = ZoneInfo(timezone_name)
    except ZoneInfoNotFoundError as exc:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, "Unknown timezone"
        ) from exc
    if not croniter.is_valid(expression):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, "Invalid cron expression"
        )
    aware = after.replace(tzinfo=timezone.utc).astimezone(tz)
    result = croniter(expression, aware).get_next(datetime)
    return result.astimezone(timezone.utc).replace(tzinfo=None)


class ProjectAutomationService:
    WAITING_RESCAN_BATCH_SIZE = 100

    def list(self, db: Session, project_id: str, user_id: int) -> list[dict]:
        require_cloud_project_role(db, project_id, user_id, BaseRole.Reporter)
        rows = (
            db.query(ProjectAutomationRule)
            .filter(
                ProjectAutomationRule.cloud_project_id == project_id,
                loop_datetime_is_unset(ProjectAutomationRule.deleted_at),
            )
            .order_by(ProjectAutomationRule.updated_at.desc())
            .all()
        )
        return [self._rule_view(db, row) for row in rows]

    def create(
        self,
        db: Session,
        project_id: str,
        user_id: int,
        values: ProjectAutomationCreate,
    ) -> dict:
        require_cloud_project_role(db, project_id, user_id, BaseRole.Maintainer)
        self._validate_assignment(
            values.assignment_mode, values.agent_id, values.trigger_type
        )
        agent = (
            self._agent(db, project_id, values.agent_id)
            if values.agent_id is not None
            else None
        )
        self._validate_trigger(
            values.trigger_type, values.event_type, values.cron_expression
        )
        now = utcnow()
        next_run_at = (
            _next_run(str(values.cron_expression), values.timezone, now)
            if values.trigger_type == "schedule"
            else None
        )
        webhook_secret = (
            secrets.token_urlsafe(32) if values.trigger_type == "event" else None
        )
        row = ProjectAutomationRule(
            cloud_project_id=project_id,
            title=values.name,
            description=values.prompt,
            assignee_agent_id=agent.id if agent else "",
            status="enabled" if values.enabled else "disabled",
            due_at=next_run_at if values.enabled else None,
            created_by_user_id=user_id,
            updated_by_user_id=user_id,
            metadata_json={
                "trigger_type": values.trigger_type,
                "event_type": values.event_type,
                "event_config": values.event_config,
                "assignment_mode": values.assignment_mode,
                "webhook_secret_encrypted": (
                    encrypt_sensitive_data_with_embedded_iv(webhook_secret)
                    if webhook_secret
                    else None
                ),
                "cron_expression": values.cron_expression,
                "timezone": values.timezone,
                "last_run_at": None,
            },
        )
        db.add(row)
        db.commit()
        db.refresh(row)
        return self._rule_view(db, row, webhook_secret=webhook_secret)

    def update(
        self,
        db: Session,
        project_id: str,
        automation_id: str,
        user_id: int,
        values: ProjectAutomationUpdate,
    ) -> dict:
        require_cloud_project_role(db, project_id, user_id, BaseRole.Maintainer)
        row = self._rule(db, project_id, automation_id, for_update=True)
        if row.version != values.version:
            raise HTTPException(status.HTTP_409_CONFLICT, "Automation version conflict")
        metadata = _metadata(row)
        trigger_type = values.trigger_type or str(
            metadata.get("trigger_type") or "schedule"
        )
        event_type = values.event_type or metadata.get("event_type")
        expression = values.cron_expression or metadata.get("cron_expression")
        timezone_name = values.timezone or str(
            metadata.get("timezone") or "Asia/Shanghai"
        )
        self._validate_trigger(trigger_type, event_type, expression)
        assignment_mode = values.assignment_mode or str(
            metadata.get("assignment_mode") or "manual"
        )
        agent_id = (
            values.agent_id if values.agent_id is not None else row.assignee_agent_id
        )
        self._validate_assignment(assignment_mode, agent_id or None, trigger_type)
        if values.agent_id is not None:
            row.assignee_agent_id = self._agent(db, project_id, values.agent_id).id
        elif assignment_mode == "automatic":
            row.assignee_agent_id = ""
        if values.name is not None:
            row.title = values.name
        if values.prompt is not None:
            row.description = values.prompt
        if values.enabled is not None:
            row.status = "enabled" if values.enabled else "disabled"
        metadata.update(
            {
                "trigger_type": trigger_type,
                "event_type": event_type,
                "event_config": (
                    values.event_config
                    if values.event_config is not None
                    else metadata.get("event_config", {})
                ),
                "assignment_mode": assignment_mode,
                "cron_expression": expression,
                "timezone": timezone_name,
            }
        )
        row.metadata_json = metadata
        row.due_at = (
            _next_run(str(expression), timezone_name, utcnow())
            if row.status == "enabled" and trigger_type == "schedule"
            else loop_unset_datetime_for_connection(db.connection(), "due_at")
        )
        row.updated_by_user_id = user_id
        row.version += 1
        db.commit()
        db.refresh(row)
        return self._rule_view(db, row)

    def delete(
        self, db: Session, project_id: str, automation_id: str, user_id: int
    ) -> None:
        require_cloud_project_role(db, project_id, user_id, BaseRole.Maintainer)
        row = self._rule(db, project_id, automation_id)
        row.deleted_at = utcnow()
        row.status = "disabled"
        row.due_at = loop_unset_datetime_for_connection(db.connection(), "due_at")
        row.version += 1
        db.commit()
        logger.info(
            "[ProjectAutomation] Deleted rule=%s project=%s user=%s",
            automation_id,
            project_id,
            user_id,
        )

    async def run_now(
        self, db: Session, project_id: str, automation_id: str, user_id: int
    ) -> dict:
        require_cloud_project_role(db, project_id, user_id, BaseRole.Developer)
        rule = self._rule(db, project_id, automation_id)
        run = self._create_run(db, rule, "manual", utcnow(), None)
        await self._dispatch_if_available(db, rule, run)
        return self._run_view(
            run, str(_metadata(rule).get("timezone") or "Asia/Shanghai")
        )

    def list_runs(
        self, db: Session, project_id: str, automation_id: str, user_id: int
    ) -> list[dict]:
        require_cloud_project_role(db, project_id, user_id, BaseRole.Reporter)
        rule = self._rule(db, project_id, automation_id)
        rule_timezone = str(_metadata(rule).get("timezone") or "Asia/Shanghai")
        rows = (
            db.query(ProjectAutomationRun)
            .filter(
                ProjectAutomationRun.parent_id == automation_id,
                loop_datetime_is_unset(ProjectAutomationRun.deleted_at),
            )
            .order_by(ProjectAutomationRun.created_at.desc())
            .limit(100)
            .all()
        )
        return [self._run_view(row, rule_timezone) for row in rows]

    def cancel_run(
        self, db: Session, project_id: str, run_id: str, user_id: int
    ) -> dict:
        require_cloud_project_role(db, project_id, user_id, BaseRole.Developer)
        run = db.get(ProjectAutomationRun, run_id)
        if run is None or str(run.cloud_project_id) != str(project_id):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Automation run not found")
        rule = db.get(ProjectAutomationRule, run.parent_id)
        rule_timezone = (
            str(_metadata(rule).get("timezone") or "Asia/Shanghai")
            if rule is not None
            else "Asia/Shanghai"
        )
        if run.status not in {"pending", "waiting_device"}:
            if run.status != "running" or not run.task_id:
                raise HTTPException(
                    status.HTTP_409_CONFLICT, "Automation run cannot be cancelled"
                )
            from app.models.loop_item_execution import LoopItemExecution

            execution = (
                db.query(LoopItemExecution)
                .filter(LoopItemExecution.loop_item_id == run.task_id)
                .order_by(LoopItemExecution.id.desc())
                .first()
            )
            if execution is None:
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    "Automation execution is unavailable for cancellation",
                )
            loop_item_execution_service.cancel(
                db,
                execution_id=execution.id,
                note="Automation run cancelled by user",
            )
            db.refresh(run)
            return self._run_view(run, rule_timezone)
        run.status = "cancelled"
        run.version += 1
        db.commit()
        db.refresh(run)
        return self._run_view(run, rule_timezone)

    async def check_due(self, db: Session) -> int:
        now = utcnow()
        rule_ids = (
            db.query(ProjectAutomationRule)
            .filter(
                ProjectAutomationRule.status == "enabled",
                ProjectAutomationRule.due_at.isnot(None),
                ProjectAutomationRule.due_at <= now,
                loop_datetime_is_unset(ProjectAutomationRule.deleted_at),
            )
            .with_entities(ProjectAutomationRule.id)
            .all()
        )
        dispatched = 0
        logger.info(
            "[ProjectAutomation] Due scan found %s candidate rule(s) at %s",
            len(rule_ids),
            now.isoformat(),
        )
        for (rule_id,) in rule_ids:
            rule = (
                db.query(ProjectAutomationRule)
                .filter(ProjectAutomationRule.id == rule_id)
                .with_for_update(skip_locked=True)
                .one_or_none()
            )
            if (
                rule is None
                or rule.status != "enabled"
                or rule.due_at is None
                or rule.due_at > now
                or not loop_datetime_value_is_unset(rule.deleted_at)
            ):
                logger.info(
                    "[ProjectAutomation] Candidate rule %s changed before lock; skipping",
                    rule_id,
                )
                continue
            metadata = _metadata(rule)
            scheduled_for = rule.due_at or now
            next_at = _next_run(
                str(metadata.get("cron_expression") or ""),
                str(metadata.get("timezone") or "Asia/Shanghai"),
                max(scheduled_for, now),
            )
            self._expire_scheduled_waits(db, rule.id)
            run = self._create_run(
                db,
                rule,
                "scheduled",
                scheduled_for,
                next_at,
                commit=False,
            )
            rule.due_at = next_at
            metadata["last_run_at"] = scheduled_for.isoformat()
            rule.metadata_json = metadata
            rule.version += 1
            db.commit()
            db.refresh(run)
            logger.info(
                "[ProjectAutomation] Created scheduled run=%s rule=%s scheduled_for=%s next=%s",
                run.id,
                rule.id,
                scheduled_for.isoformat(),
                next_at.isoformat(),
            )
            await self._dispatch_if_available(db, rule, run)
            dispatched += 1
        waiting_rule = aliased(ProjectAutomationRule)
        waits = (
            db.query(ProjectAutomationRun)
            .join(
                waiting_rule,
                waiting_rule.id == ProjectAutomationRun.parent_id,
            )
            .filter(
                ProjectAutomationRun.status == "waiting_device",
                waiting_rule.status == "enabled",
                loop_datetime_is_unset(waiting_rule.deleted_at),
            )
            .order_by(ProjectAutomationRun.created_at)
            .limit(self.WAITING_RESCAN_BATCH_SIZE)
            .all()
        )
        for run in waits:
            metadata = _metadata(run)
            if (
                metadata.get("trigger") != "scheduled"
                or not run.due_at
                or run.due_at > now
            ):
                rule = db.get(ProjectAutomationRule, run.parent_id)
                if rule is not None:
                    await self._dispatch_if_available(db, rule, run)
        return dispatched

    @staticmethod
    def _validate_assignment(
        assignment_mode: str, agent_id: str | None, trigger_type: str
    ) -> None:
        if assignment_mode == "automatic" and trigger_type != "event":
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Automatic robot selection requires an event trigger",
            )
        if assignment_mode == "manual" and not agent_id:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "agent_id is required for manual assignment",
            )

    @staticmethod
    def _validate_trigger(
        trigger_type: str, event_type: str | None, cron_expression: str | None
    ) -> None:
        if trigger_type == "schedule":
            if not cron_expression:
                raise HTTPException(
                    status.HTTP_422_UNPROCESSABLE_ENTITY,
                    "cron_expression is required for schedule trigger",
                )
            _next_run(str(cron_expression), "UTC", utcnow())
            return
        if trigger_type == "event" and event_type == "task.created":
            return
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, "Unsupported automation trigger"
        )

    async def _dispatch_if_available(
        self, db: Session, rule: ProjectAutomationRule, run: ProjectAutomationRun
    ) -> None:
        if run.status not in {"pending", "waiting_device"}:
            logger.debug(
                "[ProjectAutomation] Run=%s is no longer dispatchable status=%s",
                run.id,
                run.status,
            )
            return
        agent = db.get(ProjectChatAgent, run.assignee_agent_id)
        if agent is None or agent.status != "active":
            run.status = "failed"
            run.description = "Automation robot is unavailable"
            db.commit()
            logger.warning(
                "[ProjectAutomation] Run=%s failed because agent=%s is unavailable",
                run.id,
                run.assignee_agent_id,
            )
            return
        config = bot_config(agent)
        environment = str(config.get("execution_environment") or "local")
        device_id = config.get("execution_device_id")
        if environment == "local":
            online = (
                await device_service.get_device_online_info(
                    int(agent.created_by_user_id or rule.created_by_user_id),
                    str(device_id),
                )
                if device_id
                else None
            )
            if not online:
                run.status = "waiting_device"
                run.device_id = str(device_id or "")
                db.commit()
                logger.info(
                    "[ProjectAutomation] Run=%s waiting for local device=%s",
                    run.id,
                    device_id or "",
                )
                return
        logger.info(
            "[ProjectAutomation] Dispatching run=%s environment=%s device=%s",
            run.id,
            environment,
            device_id or "",
        )
        if _metadata(run).get("trigger") == "event":
            self._start_event_run(db, rule, run, agent, str(device_id or ""))
        else:
            self._start_run(db, rule, run, agent, str(device_id or ""))

    def _start_event_run(
        self,
        db: Session,
        rule: ProjectAutomationRule,
        run: ProjectAutomationRun,
        agent: ProjectChatAgent,
        device_id: str,
    ) -> None:
        """Run the configured robot against the task that raised the event."""

        if not run.task_id:
            run.status = "failed"
            run.description = "Automation event has no task"
            db.commit()
            return
        assignment = LoopItemAssign(
            assignee_type="agent",
            assignee_id=agent.id,
            version=1,
        )
        item = db.get(LoopItem, run.task_id)
        if item is None and external_loop_item_provider.is_external_item(
            db, run.task_id
        ):
            external_loop_item_provider.assign(
                db,
                run.task_id,
                int(rule.created_by_user_id or 0),
                assignment,
            )
            updated = db.get(LoopItem, run.task_id)
        elif item is not None:
            assignment.version = item.version
            updated = loop_item_service.assign(
                db,
                project_id=int(str(rule.cloud_project_id)),
                item_id=item.id,
                user_id=int(rule.created_by_user_id or 0),
                values=assignment,
            )
        else:
            updated = None
        if updated is None:
            run.status = "failed"
            run.description = "Automation event task is unavailable"
            db.commit()
            return
        execution = (
            db.query(LoopItemExecution)
            .filter(LoopItemExecution.loop_item_id == run.task_id)
            .order_by(LoopItemExecution.id.desc())
            .first()
        )
        if execution is None:
            run.status = "failed"
            run.description = "Automation event execution was not created"
            db.commit()
            return
        execution.execution_note = rule.description or ""
        item_metadata = _metadata(updated)
        item_metadata["automation"] = {
            "rule_id": rule.id,
            "run_id": run.id,
            "trigger": "event",
            "event": _metadata(run).get("event"),
            "prompt": rule.description or "",
        }
        updated.metadata_json = item_metadata
        run.status = "running"
        run.device_id = device_id
        run.version += 1
        db.commit()

    def activate_waiting_for_device(
        self, db: Session, *, user_id: int, device_id: str
    ) -> int:
        """Start waiting automations when a local App proves it is online.

        The App's queue claim is the authoritative liveness signal for the
        synthetic ``local-device`` alias, which is intentionally not stored as
        a cloud WebSocket device registration.
        """

        wait_ids = (
            db.query(ProjectAutomationRun)
            .filter(
                ProjectAutomationRun.status == "waiting_device",
                ProjectAutomationRun.device_id == device_id,
            )
            .with_entities(ProjectAutomationRun.id)
            .all()
        )
        activated = 0
        for (run_id,) in wait_ids:
            run = (
                db.query(ProjectAutomationRun)
                .filter(ProjectAutomationRun.id == run_id)
                .with_for_update(skip_locked=True)
                .one_or_none()
            )
            if run is None or run.status != "waiting_device":
                continue
            rule = db.get(ProjectAutomationRule, run.parent_id)
            agent = db.get(ProjectChatAgent, run.assignee_agent_id)
            if (
                rule is None
                or agent is None
                or agent.status != "active"
                or int(agent.created_by_user_id or 0) != user_id
                or str(bot_config(agent).get("execution_environment") or "local")
                != "local"
            ):
                continue
            if _metadata(run).get("trigger") == "event":
                self._start_event_run(db, rule, run, agent, device_id)
            else:
                self._start_run(db, rule, run, agent, device_id)
            activated += 1
        return activated

    def _start_run(
        self,
        db: Session,
        rule: ProjectAutomationRule,
        run: ProjectAutomationRun,
        agent: ProjectChatAgent,
        device_id: str,
    ) -> None:
        """Create the scheduled task and its queued execution."""

        creator = db.get(User, rule.created_by_user_id)
        if creator is None:
            run.status = "failed"
            run.description = "Automation owner is unavailable"
            db.commit()
            return
        run_metadata = _metadata(run)
        scheduled_value = run_metadata.get("scheduled_for")
        scheduled_for = (
            datetime.fromisoformat(scheduled_value)
            if isinstance(scheduled_value, str)
            else run.created_at
        )
        timezone_name = str(_metadata(rule).get("timezone") or "Asia/Shanghai")
        try:
            local_scheduled_for = scheduled_for.replace(tzinfo=timezone.utc).astimezone(
                ZoneInfo(timezone_name)
            )
        except ZoneInfoNotFoundError:
            local_scheduled_for = scheduled_for
        item = loop_item_service.create(
            db,
            str(rule.cloud_project_id),
            creator.id,
            LoopItemCreate(
                title=f"{rule.title} · {local_scheduled_for:%Y-%m-%d %H:%M}",
                description=rule.description or "",
                assignee_agent_id=agent.id,
                priority="medium",
                tags=["automation"],
            ),
        )
        item_metadata = _metadata(item)
        item_metadata["automation"] = {
            "rule_id": rule.id,
            "run_id": run.id,
            "trigger": run_metadata.get("trigger"),
            "scheduled_for": scheduled_for.isoformat() if scheduled_for else None,
        }
        item.metadata_json = item_metadata
        run.task_id = item.id
        run.status = "running"
        run.device_id = device_id
        run.version += 1
        db.commit()
        logger.info(
            "[ProjectAutomation] Started run=%s task=%s agent=%s device=%s",
            run.id,
            item.id,
            agent.id,
            device_id,
        )

    def _create_run(
        self,
        db: Session,
        rule: ProjectAutomationRule,
        trigger: str,
        scheduled_for: datetime,
        expires_at: datetime | None,
        *,
        commit: bool = True,
    ) -> ProjectAutomationRun:
        row = ProjectAutomationRun(
            cloud_project_id=rule.cloud_project_id,
            parent_id=rule.id,
            assignee_agent_id=rule.assignee_agent_id,
            source=trigger,
            status="pending",
            due_at=expires_at,
            created_by_user_id=rule.created_by_user_id,
            metadata_json={
                "trigger": trigger,
                "timezone": str(_metadata(rule).get("timezone") or "Asia/Shanghai"),
                "scheduled_for": scheduled_for.isoformat(),
                "error": None,
            },
        )
        db.add(row)
        if commit:
            db.commit()
            db.refresh(row)
        else:
            db.flush()
        return row

    @staticmethod
    def _expire_scheduled_waits(db: Session, automation_id: str) -> None:
        rows = (
            db.query(ProjectAutomationRun)
            .filter(
                ProjectAutomationRun.parent_id == automation_id,
                ProjectAutomationRun.status == "waiting_device",
                ProjectAutomationRun.source == "scheduled",
            )
            .all()
        )
        for row in rows:
            row.status = "skipped"
            row.description = "Local device remained offline until the next schedule"
            row.version += 1

    @staticmethod
    def _agent(db: Session, project_id: str, agent_id: str) -> ProjectChatAgent:
        agent = db.get(ProjectChatAgent, agent_id)
        if (
            agent is None
            or str(agent.cloud_project_id) != str(project_id)
            or agent.status != "active"
        ):
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY, "Robot is not active"
            )
        return agent

    @staticmethod
    def _rule(
        db: Session,
        project_id: str,
        automation_id: str,
        *,
        for_update: bool = False,
    ) -> ProjectAutomationRule:
        query = db.query(ProjectAutomationRule).filter(
            ProjectAutomationRule.id == automation_id
        )
        if for_update:
            query = query.with_for_update()
        row = query.one_or_none()
        if (
            row is None
            or str(row.cloud_project_id) != str(project_id)
            or not loop_datetime_value_is_unset(row.deleted_at)
        ):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Automation not found")
        return row

    def _rule_view(
        self,
        db: Session,
        row: ProjectAutomationRule,
        *,
        webhook_secret: str | None = None,
    ) -> dict:
        metadata = _metadata(row)
        agent = db.get(ProjectChatAgent, row.assignee_agent_id)
        last_run_row = (
            db.query(ProjectAutomationRun)
            .filter(ProjectAutomationRun.parent_id == row.id)
            .order_by(ProjectAutomationRun.created_at.desc())
            .first()
        )
        config = bot_config(agent) if agent else {}
        last_run = metadata.get("last_run_at")
        return {
            "id": row.id,
            "project_id": str(row.cloud_project_id),
            "name": row.title or "",
            "prompt": row.description or "",
            "trigger_type": str(metadata.get("trigger_type") or "schedule"),
            "event_type": metadata.get("event_type"),
            "event_config": metadata.get("event_config") or {},
            "assignment_mode": str(metadata.get("assignment_mode") or "manual"),
            "webhook_event_id": (
                row.id if metadata.get("trigger_type") == "event" else None
            ),
            "webhook_secret": webhook_secret,
            "cron_expression": metadata.get("cron_expression"),
            "timezone": str(metadata.get("timezone") or "Asia/Shanghai"),
            "agent_id": row.assignee_agent_id or None,
            "agent_name": (
                (agent.title or agent.name or "AI")
                if agent
                else "AI automatic selection"
            ),
            "execution_environment": str(
                config.get("execution_environment") or "local"
            ),
            "execution_device_id": config.get("execution_device_id"),
            "enabled": row.status == "enabled",
            "next_run_at": _utc_aware(row.due_at),
            "last_run_at": _utc_aware(
                datetime.fromisoformat(last_run) if last_run else None
            ),
            "last_run_status": last_run_row.status if last_run_row else None,
            "version": row.version,
            "created_at": _utc_aware(row.created_at),
            "updated_at": _utc_aware(row.updated_at),
        }

    @staticmethod
    def _run_view(
        row: ProjectAutomationRun, fallback_timezone: str = "Asia/Shanghai"
    ) -> dict:
        metadata = _metadata(row)
        scheduled = metadata.get("scheduled_for")
        return {
            "id": row.id,
            "automation_id": row.parent_id,
            "project_id": str(row.cloud_project_id),
            "trigger": metadata.get("trigger") or row.source or "scheduled",
            "status": row.status,
            "timezone": str(metadata.get("timezone") or fallback_timezone),
            "scheduled_for": _utc_aware(
                datetime.fromisoformat(scheduled) if scheduled else row.created_at
            ),
            "expires_at": _utc_aware(row.due_at),
            "task_id": row.task_id,
            "device_id": row.device_id or None,
            "error": row.description or None,
            "created_at": _utc_aware(row.created_at),
            "updated_at": _utc_aware(row.updated_at),
        }


project_automation_service = ProjectAutomationService()


class ProjectAutomationProcessor:
    """Process project automation events in the backend that received them."""

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
        rules = query.all()
        dispatched = 0
        for rule in rules:
            metadata = _metadata(rule)
            if metadata.get("trigger_type") != "event":
                continue
            if metadata.get("event_type") != event.event_type:
                continue
            if not self._matches(metadata.get("event_config"), event):
                continue
            agent_id = rule.assignee_agent_id
            if metadata.get("assignment_mode") == "automatic":
                try:
                    agent_id = await self._select_agent(db, rule, event)
                except Exception as exc:
                    logger.exception(
                        "[ProjectAutomation] Automatic assignment failed rule=%s",
                        rule.id,
                    )
                    run = project_automation_service._create_run(
                        db, rule, "event", utcnow(), None
                    )
                    run.task_id = event.subject_id
                    run.status = "failed"
                    run.description = str(exc)[:2000]
                    db.commit()
                    dispatched += 1
                    continue
            run = project_automation_service._create_run(
                db,
                rule,
                "event",
                utcnow(),
                None,
            )
            run.assignee_agent_id = agent_id
            run.task_id = event.subject_id
            run_metadata = _metadata(run)
            run_metadata["event"] = {
                "type": event.event_type,
                "source": event.source,
                "subject_id": event.subject_id,
                "payload": event.payload,
            }
            run.metadata_json = run_metadata
            db.commit()
            await project_automation_service._dispatch_if_available(db, rule, run)
            dispatched += 1
        return dispatched

    async def _select_agent(
        self,
        db: Session,
        rule: ProjectAutomationRule,
        event: ProjectAutomationEvent,
    ) -> str:
        owner = db.get(User, rule.created_by_user_id)
        if owner is None:
            raise ValueError("Automation owner is unavailable")
        agents = (
            db.query(ProjectChatAgent)
            .filter(
                ProjectChatAgent.cloud_project_id == event.project_id,
                ProjectChatAgent.status == "active",
                loop_datetime_is_unset(ProjectChatAgent.deleted_at),
            )
            .order_by(ProjectChatAgent.created_at)
            .all()
        )
        if not agents:
            raise ValueError("No active project robots are available")
        model = self._selection_model(db, owner)
        candidates = [
            {
                "agent_id": agent.id,
                "name": agent.title or agent.name or "AI",
                "capability": str(bot_config(agent).get("system_prompt") or ""),
            }
            for agent in agents
        ]
        response = await simple_chat_service.chat_completion(
            message=json.dumps(
                {
                    "rule_instruction": rule.description or "",
                    "task": event.payload,
                    "candidates": candidates,
                },
                ensure_ascii=False,
            ),
            model_config=model,
            system_prompt=(
                "Select exactly one project robot for the task. Base the decision "
                "only on the task and candidate capabilities. Return JSON only: "
                '{"agent_id":"<one candidate agent_id>"}.'
            ),
        )
        selected_id = self._selected_agent_id(response)
        if selected_id not in {agent.id for agent in agents}:
            raise ValueError("AI returned an invalid project robot")
        return selected_id

    @staticmethod
    def _selection_model(db: Session, owner: User) -> dict:
        model = (
            db.query(Kind)
            .filter(
                Kind.kind == "Model",
                Kind.is_active == True,
                Kind.user_id.in_([owner.id, 0]),
            )
            .order_by((Kind.user_id == owner.id).desc(), Kind.id)
            .first()
        )
        if model is None:
            raise ValueError("No model is available for automatic assignment")
        return extract_and_process_model_config(
            model_spec=(model.json or {}).get("spec", {}),
            user_id=owner.id,
            user_name=owner.user_name or "",
        )

    @staticmethod
    def _selected_agent_id(response: str) -> str:
        text = response.strip()
        if text.startswith("```"):
            text = text.removeprefix("```json").removeprefix("```")
            text = text.removesuffix("```").strip()
        try:
            value = json.loads(text)
        except json.JSONDecodeError as exc:
            raise ValueError("AI returned invalid assignment JSON") from exc
        agent_id = value.get("agent_id") if isinstance(value, dict) else None
        if not isinstance(agent_id, str) or not agent_id:
            raise ValueError("AI did not select a project robot")
        return agent_id

    @staticmethod
    def _matches(config: object, event: ProjectAutomationEvent) -> bool:
        if not isinstance(config, dict):
            return True
        sources = config.get("sources")
        if isinstance(sources, list) and sources and event.source not in sources:
            return False
        for field in ("statuses", "priorities"):
            expected = config.get(field)
            payload_key = (
                field.removesuffix("es") if field == "statuses" else "priority"
            )
            if (
                isinstance(expected, list)
                and expected
                and event.payload.get(payload_key) not in expected
            ):
                return False
        expected_tags = config.get("tags")
        actual_tags = event.payload.get("tags")
        if isinstance(expected_tags, list) and expected_tags:
            if not set(expected_tags).intersection(
                actual_tags if isinstance(actual_tags, list) else []
            ):
                return False
        return True


project_automation_processor = ProjectAutomationProcessor()
