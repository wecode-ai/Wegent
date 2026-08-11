# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Project-scoped automation rules and scheduled board runs."""

from __future__ import annotations

import hashlib
from datetime import datetime, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from croniter import croniter
from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.delivery import (
    CloudProject,
    LoopItem,
    ProjectAutomationBugLink,
    ProjectAutomationRule,
    ProjectAutomationRun,
    ProjectChatAgent,
    loop_datetime_is_unset,
)
from app.models.user import User
from app.schemas.base_role import BaseRole
from app.schemas.delivery import LoopItemCreate
from app.schemas.project_automation import (
    AutomationBugUpsert,
    ProjectAutomationCreate,
    ProjectAutomationUpdate,
)
from app.services.cloud_projects.access import require_cloud_project_role
from app.services.device_service import device_service
from app.services.loop_item_executions.service import loop_item_execution_service
from app.services.loop_items.service import loop_item_service
from app.services.project_chat.service import bot_config


def utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


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
        agent = self._agent(db, project_id, values.agent_id)
        now = utcnow()
        next_run_at = _next_run(values.cron_expression, values.timezone, now)
        row = ProjectAutomationRule(
            cloud_project_id=project_id,
            title=values.name,
            description=values.prompt,
            assignee_agent_id=agent.id,
            status="enabled" if values.enabled else "disabled",
            due_at=next_run_at if values.enabled else None,
            created_by_user_id=user_id,
            updated_by_user_id=user_id,
            metadata_json={
                "cron_expression": values.cron_expression,
                "timezone": values.timezone,
                "last_run_at": None,
            },
        )
        db.add(row)
        db.commit()
        db.refresh(row)
        return self._rule_view(db, row)

    def update(
        self,
        db: Session,
        project_id: str,
        automation_id: str,
        user_id: int,
        values: ProjectAutomationUpdate,
    ) -> dict:
        require_cloud_project_role(db, project_id, user_id, BaseRole.Maintainer)
        row = self._rule(db, project_id, automation_id)
        if row.version != values.version:
            raise HTTPException(status.HTTP_409_CONFLICT, "Automation version conflict")
        metadata = _metadata(row)
        expression = values.cron_expression or str(
            metadata.get("cron_expression") or ""
        )
        timezone_name = values.timezone or str(metadata.get("timezone") or "UTC")
        _next_run(expression, timezone_name, utcnow())
        if values.agent_id is not None:
            row.assignee_agent_id = self._agent(db, project_id, values.agent_id).id
        if values.name is not None:
            row.title = values.name
        if values.prompt is not None:
            row.description = values.prompt
        if values.enabled is not None:
            row.status = "enabled" if values.enabled else "disabled"
        metadata.update({"cron_expression": expression, "timezone": timezone_name})
        row.metadata_json = metadata
        row.due_at = (
            _next_run(expression, timezone_name, utcnow())
            if row.status == "enabled"
            else None
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
        row.due_at = None
        row.version += 1
        db.commit()

    async def run_now(
        self, db: Session, project_id: str, automation_id: str, user_id: int
    ) -> dict:
        require_cloud_project_role(db, project_id, user_id, BaseRole.Developer)
        rule = self._rule(db, project_id, automation_id)
        run = self._create_run(db, rule, "manual", utcnow(), None)
        await self._dispatch_if_available(db, rule, run)
        return self._run_view(run)

    def list_runs(
        self, db: Session, project_id: str, automation_id: str, user_id: int
    ) -> list[dict]:
        require_cloud_project_role(db, project_id, user_id, BaseRole.Reporter)
        self._rule(db, project_id, automation_id)
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
        return [self._run_view(row) for row in rows]

    def cancel_run(
        self, db: Session, project_id: str, run_id: str, user_id: int
    ) -> dict:
        require_cloud_project_role(db, project_id, user_id, BaseRole.Developer)
        run = db.get(ProjectAutomationRun, run_id)
        if run is None or str(run.cloud_project_id) != str(project_id):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Automation run not found")
        if run.status not in {"pending", "waiting_device"}:
            raise HTTPException(
                status.HTTP_409_CONFLICT, "Automation run cannot be cancelled"
            )
        run.status = "cancelled"
        run.version += 1
        db.commit()
        db.refresh(run)
        return self._run_view(run)

    async def check_due(self, db: Session) -> int:
        now = utcnow()
        rules = (
            db.query(ProjectAutomationRule)
            .filter(
                ProjectAutomationRule.status == "enabled",
                ProjectAutomationRule.due_at.isnot(None),
                ProjectAutomationRule.due_at <= now,
                loop_datetime_is_unset(ProjectAutomationRule.deleted_at),
            )
            .with_for_update(skip_locked=True)
            .all()
        )
        dispatched = 0
        for rule in rules:
            metadata = _metadata(rule)
            scheduled_for = rule.due_at or now
            next_at = _next_run(
                str(metadata.get("cron_expression") or ""),
                str(metadata.get("timezone") or "UTC"),
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
            await self._dispatch_if_available(db, rule, run)
            dispatched += 1
        waits = (
            db.query(ProjectAutomationRun)
            .filter(ProjectAutomationRun.status == "waiting_device")
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

    async def upsert_bug(
        self,
        db: Session,
        run_id: str,
        user: User,
        values: AutomationBugUpsert,
    ) -> tuple[str, LoopItem]:
        run = db.get(ProjectAutomationRun, run_id)
        if run is None or run.status != "running" or not run.task_id:
            raise HTTPException(
                status.HTTP_404_NOT_FOUND, "Active automation run not found"
            )
        rule = db.get(ProjectAutomationRule, run.parent_id)
        if rule is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Automation not found")
        require_cloud_project_role(
            db, str(rule.cloud_project_id), user.id, BaseRole.Developer
        )
        digest = hashlib.sha256(values.bug_key.encode("utf-8")).hexdigest()
        link = (
            db.query(ProjectAutomationBugLink)
            .filter(
                ProjectAutomationBugLink.parent_id == rule.id,
                ProjectAutomationBugLink.sha256 == digest,
                loop_datetime_is_unset(ProjectAutomationBugLink.deleted_at),
            )
            .first()
        )
        evidence = values.evidence
        if values.reproduction:
            evidence = f"{evidence}\n\n## Reproduction\n{values.reproduction}"
        if link is not None and link.loop_item_id:
            item = db.get(LoopItem, link.loop_item_id)
            if item is not None:
                action = "reopened" if item.status == "completed" else "updated"
                item.title = values.title
                item.description = evidence
                item.priority = values.priority
                if action == "reopened":
                    project = db.get(CloudProject, rule.cloud_project_id)
                    statuses = (
                        loop_item_service._project_status_ids(project)
                        if project
                        else []
                    )
                    item.status = statuses[0] if statuses else item.status
                    item.completed_at = None
                    agent = db.get(ProjectChatAgent, rule.assignee_agent_id)
                    if agent is not None:
                        config = bot_config(agent)
                        loop_item_execution_service.create_for_assignment(
                            db,
                            loop_item_id=item.id,
                            cloud_project_id=str(rule.cloud_project_id),
                            agent=agent,
                            assigner_user_id=user.id,
                            environment=str(
                                config.get("execution_environment") or "local"
                            ),
                            execution_device_id=(
                                config.get("execution_device_id")
                                if isinstance(config.get("execution_device_id"), str)
                                else None
                            ),
                            priority=item.priority,
                        )
                item.updated_by_user_id = user.id
                item.version += 1
                db.commit()
                db.refresh(item)
                return action, item
        item = loop_item_service.create(
            db,
            str(rule.cloud_project_id),
            user.id,
            LoopItemCreate(
                title=values.title,
                description=evidence,
                parent_id=run.task_id,
                assignee_agent_id=rule.assignee_agent_id,
                priority=values.priority,
                tags=["automation", "bug"],
            ),
        )
        item_metadata = _metadata(item)
        item_metadata["automation"] = {
            "rule_id": rule.id,
            "run_id": run.id,
            "bug_key": values.bug_key,
            "trigger": _metadata(run).get("trigger"),
            "scheduled_for": _metadata(run).get("scheduled_for"),
        }
        item.metadata_json = item_metadata
        link = ProjectAutomationBugLink(
            cloud_project_id=rule.cloud_project_id,
            parent_id=rule.id,
            loop_item_id=item.id,
            name=values.bug_key,
            sha256=digest,
            status="active",
            created_by_user_id=user.id,
        )
        db.add(link)
        db.commit()
        return "created", item

    async def _dispatch_if_available(
        self, db: Session, rule: ProjectAutomationRule, run: ProjectAutomationRun
    ) -> None:
        if run.status not in {"pending", "waiting_device"}:
            return
        agent = db.get(ProjectChatAgent, rule.assignee_agent_id)
        if agent is None or agent.status != "active":
            run.status = "failed"
            run.description = "Automation robot is unavailable"
            db.commit()
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
                return
        self._start_run(db, rule, run, agent, str(device_id or ""))

    def activate_waiting_for_device(
        self, db: Session, *, user_id: int, device_id: str
    ) -> int:
        """Start waiting automations when a local App proves it is online.

        The App's queue claim is the authoritative liveness signal for the
        synthetic ``local-device`` alias, which is intentionally not stored as
        a cloud WebSocket device registration.
        """

        waits = (
            db.query(ProjectAutomationRun)
            .filter(
                ProjectAutomationRun.status == "waiting_device",
                ProjectAutomationRun.device_id == device_id,
            )
            .with_for_update(skip_locked=True)
            .all()
        )
        activated = 0
        for run in waits:
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
        """Create the scan task and its queued execution for an available runner."""

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
        item = loop_item_service.create(
            db,
            str(rule.cloud_project_id),
            creator.id,
            LoopItemCreate(
                title=f"{rule.title} · {scheduled_for:%Y-%m-%d %H:%M}",
                description=self._scan_prompt(rule, run),
                assignee_agent_id=agent.id,
                priority="medium",
                tags=["automation", "bug-scan"],
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

    @staticmethod
    def _scan_prompt(rule: ProjectAutomationRule, run: ProjectAutomationRun) -> str:
        return (
            f"{rule.description}\n\n"
            "This is a Wework board automation scan. Do not fix multiple bugs in this "
            "parent task. For every bug, call report_automation_bug with a stable bug_key, "
            "evidence, reproduction steps, and priority. Each reported bug becomes an "
            f"independent child repair task. Automation run id: {run.id}."
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
        db: Session, project_id: str, automation_id: str
    ) -> ProjectAutomationRule:
        row = db.get(ProjectAutomationRule, automation_id)
        if (
            row is None
            or str(row.cloud_project_id) != str(project_id)
            or row.deleted_at is not None
        ):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Automation not found")
        return row

    def _rule_view(self, db: Session, row: ProjectAutomationRule) -> dict:
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
            "cron_expression": str(metadata.get("cron_expression") or ""),
            "timezone": str(metadata.get("timezone") or "UTC"),
            "agent_id": row.assignee_agent_id,
            "agent_name": (
                (agent.title or agent.name or "AI") if agent else "Unavailable"
            ),
            "execution_environment": str(
                config.get("execution_environment") or "local"
            ),
            "execution_device_id": config.get("execution_device_id"),
            "enabled": row.status == "enabled",
            "next_run_at": row.due_at,
            "last_run_at": datetime.fromisoformat(last_run) if last_run else None,
            "last_run_status": last_run_row.status if last_run_row else None,
            "version": row.version,
            "created_at": row.created_at,
            "updated_at": row.updated_at,
        }

    @staticmethod
    def _run_view(row: ProjectAutomationRun) -> dict:
        metadata = _metadata(row)
        scheduled = metadata.get("scheduled_for")
        return {
            "id": row.id,
            "automation_id": row.parent_id,
            "project_id": str(row.cloud_project_id),
            "trigger": metadata.get("trigger") or row.source or "scheduled",
            "status": row.status,
            "scheduled_for": (
                datetime.fromisoformat(scheduled) if scheduled else row.created_at
            ),
            "expires_at": row.due_at,
            "task_id": row.task_id,
            "device_id": row.device_id or None,
            "error": row.description or None,
            "created_at": row.created_at,
            "updated_at": row.updated_at,
        }


project_automation_service = ProjectAutomationService()
