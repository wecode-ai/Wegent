# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Best-effort IM notifications for committed cloud-board task changes."""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Iterable

from sqlalchemy.orm import Session

from app.core.cache import cache_manager
from app.db.session import SessionLocal
from app.models.delivery import (
    CloudProject,
    LoopItem,
    LoopItemCollaborator,
    ProjectChatAgent,
)
from app.models.user import User
from app.services.im.notification_dispatcher import im_notification_dispatcher
from app.services.im.session_service import im_session_service

logger = logging.getLogger(__name__)

IDEMPOTENCY_TTL_SECONDS = 7 * 24 * 60 * 60
IDEMPOTENCY_PREFIX = "channel:cloud_task_notification:"


@dataclass(frozen=True)
class CloudTaskSnapshot:
    project_id: str
    project_name: str
    task_id: str
    title: str
    created_by_user_id: int | None = None
    assignee_user_id: int | None = None
    assignee_agent_id: str | None = None
    assignee_agent_owner_user_id: int | None = None
    collaborator_user_ids: tuple[int, ...] = ()
    status: str | None = None
    priority: str | None = None
    due_at: datetime | None = None


@dataclass(frozen=True)
class CloudTaskNotificationEvent:
    event_id: str
    event_type: str
    actor_user_id: int
    actor_name: str
    before: CloudTaskSnapshot | None = None
    after: CloudTaskSnapshot | None = None
    summary: str = ""
    recipient_user_ids: tuple[int, ...] = field(default_factory=tuple)

    @property
    def snapshot(self) -> CloudTaskSnapshot:
        snapshot = self.after or self.before
        if snapshot is None:
            raise ValueError("Cloud task notification requires a task snapshot")
        return snapshot


class CloudTaskNotificationService:
    """Build and deliver task notifications without affecting task writes."""

    def snapshot(
        self,
        db: Session,
        *,
        project: CloudProject,
        values: LoopItem | dict[str, Any],
    ) -> CloudTaskSnapshot:
        data = values if isinstance(values, dict) else values.__dict__
        task_id = str(data.get("id") or "")
        collaborator_ids = self._collaborator_ids(db, task_id)
        agent_owner_id = self._agent_owner_id(
            db, _optional_str(data.get("assignee_agent_id"))
        )
        return CloudTaskSnapshot(
            project_id=str(project.id),
            project_name=str(project.name or project.project_key or project.id),
            task_id=task_id,
            title=str(data.get("title") or data.get("name") or task_id),
            created_by_user_id=_optional_int(data.get("created_by_user_id")),
            assignee_user_id=_optional_int(data.get("assignee_user_id")),
            assignee_agent_id=_optional_str(data.get("assignee_agent_id")),
            assignee_agent_owner_user_id=agent_owner_id,
            collaborator_user_ids=tuple(collaborator_ids),
            status=_optional_str(data.get("status")),
            priority=_optional_str(data.get("priority")),
            due_at=_optional_datetime(data.get("due_at")),
        )

    def event(
        self,
        *,
        event_id: str,
        event_type: str,
        actor: User,
        before: CloudTaskSnapshot | None = None,
        after: CloudTaskSnapshot | None = None,
        summary: str = "",
        recipient_user_ids: Iterable[int] = (),
    ) -> CloudTaskNotificationEvent:
        return self.event_for_actor(
            event_id=event_id,
            event_type=event_type,
            actor_user_id=actor.id,
            actor_name=actor.user_name,
            before=before,
            after=after,
            summary=summary,
            recipient_user_ids=recipient_user_ids,
        )

    def event_for_actor(
        self,
        *,
        event_id: str,
        event_type: str,
        actor_user_id: int,
        actor_name: str,
        before: CloudTaskSnapshot | None = None,
        after: CloudTaskSnapshot | None = None,
        summary: str = "",
        recipient_user_ids: Iterable[int] = (),
    ) -> CloudTaskNotificationEvent:
        return CloudTaskNotificationEvent(
            event_id=event_id,
            event_type=event_type,
            actor_user_id=actor_user_id,
            actor_name=actor_name,
            before=before,
            after=after,
            summary=summary.strip(),
            recipient_user_ids=tuple(
                sorted({user_id for user_id in recipient_user_ids if user_id > 0})
            ),
        )

    def change_summary(
        self,
        before: CloudTaskSnapshot | None,
        after: CloudTaskSnapshot | None,
    ) -> str:
        return _snapshot_change_summary(before, after)

    async def dispatch(self, event: CloudTaskNotificationEvent) -> dict[str, Any]:
        """Deliver one committed event once, selecting each user's latest chat."""

        claimed = await cache_manager.setnx(
            f"{IDEMPOTENCY_PREFIX}{event.event_id}",
            {"created_at": datetime.now().isoformat()},
            expire=IDEMPOTENCY_TTL_SECONDS,
        )
        if not claimed:
            return {"sent": 0, "results": [], "skipped": "duplicate_or_cache_error"}

        recipients = self._recipient_ids(event)
        message = self._message(event)
        sent = 0
        results: list[dict[str, Any]] = []
        db = SessionLocal()
        try:
            for user_id in recipients:
                sessions = await im_session_service.list_user_sessions(
                    db, user_id=user_id
                )
                if not sessions:
                    results.append(
                        {"success": False, "user_id": user_id, "error": "No IM session"}
                    )
                    continue
                session = max(sessions, key=lambda item: item.last_seen_at)
                result = await im_notification_dispatcher.send_text(
                    db, session, message
                )
                result.setdefault("user_id", user_id)
                result.setdefault("session_key", session.session_key)
                results.append(result)
                if result.get("success"):
                    sent += 1
        except Exception:
            logger.exception(
                "[CloudTaskNotification] Dispatch failed: event_id=%s event_type=%s",
                event.event_id,
                event.event_type,
            )
        finally:
            db.close()
        return {"sent": sent, "results": results}

    def _recipient_ids(self, event: CloudTaskNotificationEvent) -> list[int]:
        ids = {event.actor_user_id, *event.recipient_user_ids}
        for snapshot in (event.before, event.after):
            if snapshot is None:
                continue
            ids.update(snapshot.collaborator_user_ids)
            ids.update(
                user_id
                for user_id in (
                    snapshot.created_by_user_id,
                    snapshot.assignee_user_id,
                    snapshot.assignee_agent_owner_user_id,
                )
                if user_id is not None
            )
        return sorted(user_id for user_id in ids if user_id > 0)

    @staticmethod
    def _message(event: CloudTaskNotificationEvent) -> str:
        snapshot = event.snapshot
        heading = f"云看板任务「{snapshot.task_id} · {snapshot.title}」"
        action = {
            "created": "已创建",
            "archived": "已归档",
            "restored": "已恢复",
            "comment_added": "有新评论",
            "ai_completed": "AI 执行已完成",
            "ai_failed": "AI 执行失败",
            "external_record_created": "已创建",
            "external_record_updated": "已更新",
            "external_record_deleted": "已删除",
        }.get(event.event_type, "已更新")
        lines = [
            f"{heading}{action}",
            f"项目：{snapshot.project_name}",
            f"操作人：{event.actor_name}",
        ]
        change_summary = event.summary or _snapshot_change_summary(
            event.before, event.after
        )
        if change_summary:
            lines.append(f"变更：{change_summary}")
        return "\n".join(lines)

    @staticmethod
    def _collaborator_ids(db: Session, task_id: str) -> list[int]:
        if not task_id:
            return []
        return [
            int(user_id)
            for (user_id,) in db.query(LoopItemCollaborator.user_id)
            .filter(LoopItemCollaborator.loop_item_id == task_id)
            .all()
            if user_id
        ]

    @staticmethod
    def _agent_owner_id(db: Session, agent_id: str | None) -> int | None:
        if not agent_id:
            return None
        agent = db.get(ProjectChatAgent, agent_id)
        return _optional_int(agent.created_by_user_id) if agent is not None else None


def _snapshot_change_summary(
    before: CloudTaskSnapshot | None,
    after: CloudTaskSnapshot | None,
) -> str:
    if before is None or after is None:
        return ""
    changes: list[str] = []
    if before.status != after.status:
        changes.append(f"状态 {before.status or '未设置'} → {after.status or '未设置'}")
    if (
        before.assignee_user_id != after.assignee_user_id
        or before.assignee_agent_id != after.assignee_agent_id
        or before.assignee_agent_owner_user_id != after.assignee_agent_owner_user_id
    ):
        changes.append("负责人已变更")
    if before.priority != after.priority:
        changes.append(
            f"优先级 {before.priority or '未设置'} → {after.priority or '未设置'}"
        )
    if before.due_at != after.due_at:
        changes.append(
            f"截止时间 {_format_datetime(before.due_at)} → {_format_datetime(after.due_at)}"
        )
    return "；".join(changes)


def _format_datetime(value: datetime | None) -> str:
    return value.isoformat(sep=" ", timespec="minutes") if value else "未设置"


def _optional_int(value: object) -> int | None:
    if isinstance(value, bool) or value in (None, "", 0, "0"):
        return None
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def _optional_str(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = value.strip()
    return normalized or None


def _optional_datetime(value: object) -> datetime | None:
    if isinstance(value, datetime):
        return value
    if isinstance(value, str) and value:
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    return None


cloud_task_notification_service = CloudTaskNotificationService()
