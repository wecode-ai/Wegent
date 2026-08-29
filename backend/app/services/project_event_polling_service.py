# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Durable scheduling and persistence for project event polling."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Mapping

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, aliased

from app.core.provider_credentials import decrypt_provider_token
from app.db.session import SessionLocal
from app.models.delivery import (
    CloudProject,
    ProjectIncomingEvent,
    ProjectIncomingHook,
    loop_datetime_is_unset,
    loop_datetime_value_is_unset,
)
from app.services.connector_connections import connector_connection_service
from app.services.project_automation_domain import utcnow
from app.services.project_event_polling import (
    EventPollingError,
    PolledInput,
    poller_for,
)

MAX_SCAN_PAGES = 20
POLL_LEASE_SECONDS = 300
logger = logging.getLogger(__name__)


def resolve_polling_credential(
    db: Session,
    hook: ProjectIncomingHook,
    *,
    validate_only: bool = False,
) -> str:
    """Resolve an explicit credential reference without exposing plaintext."""

    metadata = _mapping(hook.metadata_json)
    source_type = _text(metadata.get("source_type") or hook.source)
    credential_ref = _text(metadata.get("credential_ref"))
    if not credential_ref:
        raise EventPollingError(
            "Polling requires a credential reference",
            disable_subscription=True,
        )
    if credential_ref == "project-provider":
        project = db.get(CloudProject, hook.cloud_project_id)
        if project is None:
            raise EventPollingError(
                "Project provider credential is unavailable",
                disable_subscription=True,
            )
        project_metadata = _mapping(project.metadata_json)
        task_provider = _text(project_metadata.get("task_provider"))
        if task_provider != source_type:
            raise EventPollingError(
                "Project provider does not match the event source",
                disable_subscription=True,
            )
        try:
            token = decrypt_provider_token(
                task_provider,
                project_metadata.get("provider_config"),
            )
        except ValueError as exc:
            raise EventPollingError(
                str(exc),
                disable_subscription=True,
            ) from exc
        if not token:
            raise EventPollingError(
                "Project provider credential is not configured",
                disable_subscription=True,
            )
        return "configured" if validate_only else token

    connection = connector_connection_service.get(
        db,
        slug=credential_ref,
        user_id=int(hook.created_by_user_id or 0),
    )
    if connection is None or connection.status != "connected":
        raise EventPollingError(
            f"Connector credential '{credential_ref}' is not connected",
            disable_subscription=True,
        )
    if connection.expires_at is not None and connection.expires_at <= datetime.now(
        timezone.utc
    ).replace(tzinfo=None):
        raise EventPollingError(
            f"Connector credential '{credential_ref}' has expired",
            disable_subscription=True,
        )
    token = connection.access_token()
    if not token:
        raise EventPollingError(
            f"Connector credential '{credential_ref}' is unavailable",
            disable_subscription=True,
        )
    return "configured" if validate_only else token


class ProjectEventPollingService:
    """Claim due subscriptions and persist discovered inputs page by page."""

    async def check_due(self, db: Session) -> int:
        now = utcnow()
        active_project = aliased(CloudProject)
        hook_ids = (
            db.query(ProjectIncomingHook.id)
            .join(
                active_project,
                active_project.id == ProjectIncomingHook.cloud_project_id,
            )
            .filter(
                active_project.status == "active",
                ProjectIncomingHook.status == "active",
                ~loop_datetime_is_unset(ProjectIncomingHook.due_at),
                ProjectIncomingHook.due_at <= now,
                loop_datetime_is_unset(ProjectIncomingHook.deleted_at),
            )
            .order_by(ProjectIncomingHook.due_at.asc())
            .limit(100)
            .all()
        )
        discovered = 0
        for (hook_id,) in hook_ids:
            if not self._claim(db, str(hook_id), now):
                continue
            discovered += await self.poll_subscription(db, str(hook_id))
        return discovered

    async def poll_subscription(self, db: Session, hook_id: str) -> int:
        hook = db.get(ProjectIncomingHook, hook_id)
        if hook is None:
            return 0
        metadata = _mapping(hook.metadata_json)
        source_type = _text(metadata.get("source_type") or hook.source)
        resource = _mapping(metadata.get("resource"))
        poll = _mapping(metadata.get("poll"))
        cursor = _mapping(poll.get("cursor")) or None
        discovered = 0
        try:
            credential = resolve_polling_credential(db, hook)
            adapter = poller_for(source_type)
            for _ in range(MAX_SCAN_PAGES):
                page = await adapter.fetch_page(
                    resource=resource,
                    credential=credential,
                    cursor=cursor,
                )
                discovered += self._persist_page(
                    db,
                    hook_id=hook_id,
                    source_type=source_type,
                    inputs=page.inputs,
                    next_cursor=page.next_cursor,
                )
                cursor = page.next_cursor
                if page.complete:
                    self._record_success(db, hook_id, discovered)
                    return discovered
            self._schedule_continuation(db, hook_id)
            return discovered
        except EventPollingError as exc:
            db.rollback()
            self._record_failure(db, hook_id, exc)
            logger.warning(
                "[ProjectEventPolling] Poll failed hook=%s source=%s error=%s",
                hook_id,
                source_type,
                exc,
            )
            return discovered
        except Exception as exc:
            db.rollback()
            logger.exception(
                "[ProjectEventPolling] Unexpected poll failure hook=%s source=%s",
                hook_id,
                source_type,
            )
            self._record_failure(
                db,
                hook_id,
                EventPollingError(str(exc) or "Event source polling failed"),
            )
            return discovered

    def validate_configuration(self, db: Session, hook: ProjectIncomingHook) -> None:
        metadata = _mapping(hook.metadata_json)
        source_type = _text(metadata.get("source_type") or hook.source)
        poller_for(source_type)
        resolve_polling_credential(db, hook, validate_only=True)

    def _claim(self, db: Session, hook_id: str, now: datetime) -> bool:
        hook = (
            db.query(ProjectIncomingHook)
            .filter(ProjectIncomingHook.id == hook_id)
            .with_for_update(skip_locked=True)
            .one_or_none()
        )
        if (
            hook is None
            or hook.status != "active"
            or loop_datetime_value_is_unset(hook.due_at)
            or hook.due_at > now
            or not loop_datetime_value_is_unset(hook.deleted_at)
        ):
            return False
        metadata = _mapping(hook.metadata_json)
        if metadata.get("collection_mode") not in {"poll", "hybrid"}:
            hook.due_at = None
            db.commit()
            return False
        poll = _mapping(metadata.get("poll"))
        poll["lease_started_at"] = now.isoformat()
        metadata["poll"] = poll
        hook.metadata_json = metadata
        hook.due_at = now + timedelta(seconds=POLL_LEASE_SECONDS)
        hook.version += 1
        db.commit()
        return True

    def _persist_page(
        self,
        db: Session,
        *,
        hook_id: str,
        source_type: str,
        inputs: tuple[PolledInput, ...],
        next_cursor: Mapping[str, Any],
    ) -> int:
        hook = (
            db.query(ProjectIncomingHook)
            .filter(ProjectIncomingHook.id == hook_id)
            .with_for_update()
            .one_or_none()
        )
        if hook is None or hook.status != "active":
            raise EventPollingError("Event subscription is unavailable")
        identities = {
            item.identity: hashlib.sha256(
                f"{hook.id}:{source_type}:{item.identity}".encode()
            ).hexdigest()[:36]
            for item in inputs
        }
        existing = {
            value
            for (value,) in db.query(ProjectIncomingEvent.public_id)
            .filter(ProjectIncomingEvent.public_id.in_(list(identities.values())))
            .all()
        }
        created = 0
        for item in inputs:
            public_id = identities[item.identity]
            if public_id in existing:
                continue
            raw_body = json.dumps(
                item.payload,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
                default=str,
            ).encode()
            db.add(
                ProjectIncomingEvent(
                    public_id=public_id,
                    cloud_project_id=str(hook.cloud_project_id),
                    parent_id=str(hook.id),
                    title=item.title[:255],
                    source=source_type,
                    status="received",
                    created_by_user_id=hook.created_by_user_id,
                    metadata_json={
                        "schema_version": 1,
                        "collection_mode": "poll",
                        "attempt_count": 0,
                        "poll_identity": item.identity,
                        "occurred_at": item.occurred_at,
                        "payload": item.payload,
                        "payload_sha256": hashlib.sha256(raw_body).hexdigest(),
                        "payload_size": len(raw_body),
                        "headers": item.headers,
                    },
                )
            )
            created += 1
        metadata = _mapping(hook.metadata_json)
        poll = _mapping(metadata.get("poll"))
        poll["cursor"] = dict(next_cursor)
        poll["last_page_at"] = utcnow().isoformat()
        metadata["poll"] = poll
        hook.metadata_json = metadata
        hook.version += 1
        try:
            db.commit()
        except IntegrityError as exc:
            db.rollback()
            raise EventPollingError(
                "Concurrent polling input persistence failed"
            ) from exc
        return created

    def _record_success(self, db: Session, hook_id: str, discovered: int) -> None:
        hook = db.get(ProjectIncomingHook, hook_id)
        if hook is None:
            return
        metadata = _mapping(hook.metadata_json)
        poll = _mapping(metadata.get("poll"))
        poll["failure_count"] = 0
        poll["last_polled_at"] = utcnow().isoformat()
        poll.pop("lease_started_at", None)
        metadata["poll"] = poll
        health = _mapping(metadata.get("health"))
        health.update(
            {
                "status": "healthy",
                "checked_at": utcnow().isoformat(),
            }
        )
        health.pop("last_error", None)
        metadata["health"] = health
        if discovered:
            metadata["last_event_at"] = utcnow().isoformat()
        hook.metadata_json = metadata
        hook.due_at = utcnow() + timedelta(seconds=self._jittered_interval(hook, poll))
        hook.version += 1
        db.commit()

    def _schedule_continuation(self, db: Session, hook_id: str) -> None:
        hook = db.get(ProjectIncomingHook, hook_id)
        if hook is None:
            return
        metadata = _mapping(hook.metadata_json)
        poll = _mapping(metadata.get("poll"))
        poll.pop("lease_started_at", None)
        metadata["poll"] = poll
        hook.metadata_json = metadata
        hook.due_at = utcnow() + timedelta(seconds=5)
        hook.version += 1
        db.commit()

    def _record_failure(
        self,
        db: Session,
        hook_id: str,
        error: EventPollingError,
    ) -> None:
        hook = db.get(ProjectIncomingHook, hook_id)
        if hook is None:
            return
        metadata = _mapping(hook.metadata_json)
        poll = _mapping(metadata.get("poll"))
        failures = int(poll.get("failure_count") or 0) + 1
        poll["failure_count"] = failures
        poll["last_failure_at"] = utcnow().isoformat()
        poll.pop("lease_started_at", None)
        metadata["poll"] = poll
        health = _mapping(metadata.get("health"))
        health.update(
            {
                "status": "error",
                "checked_at": utcnow().isoformat(),
                "last_error": str(error),
            }
        )
        metadata["health"] = health
        hook.metadata_json = metadata
        if error.disable_subscription:
            hook.status = "disabled"
            hook.due_at = None
        else:
            retry_after = error.retry_after_seconds or min(
                60 * (2 ** (failures - 1)),
                3600,
            )
            hook.due_at = utcnow() + timedelta(seconds=retry_after)
        hook.version += 1
        db.commit()

    @staticmethod
    def _jittered_interval(
        hook: ProjectIncomingHook,
        poll: Mapping[str, Any],
    ) -> int:
        interval = max(int(poll.get("interval_seconds") or 300), 60)
        spread = max(interval // 10, 1)
        digest = hashlib.sha256(
            f"{hook.id}:{poll.get('last_polled_at')}".encode()
        ).digest()
        offset = int.from_bytes(digest[:2], "big") % (spread * 2 + 1) - spread
        return max(interval + offset, 60)


def _mapping(value: object) -> dict[str, Any]:
    return dict(value) if isinstance(value, dict) else {}


def _text(value: object) -> str:
    return value.strip() if isinstance(value, str) else ""


def check_due_project_event_subscriptions_sync() -> int:
    with SessionLocal() as db:
        return asyncio.run(project_event_polling_service.check_due(db))


project_event_polling_service = ProjectEventPollingService()
