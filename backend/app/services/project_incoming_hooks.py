# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Unified external event ingestion and persistence for project incoming hooks."""

import hashlib
import json
import logging
import secrets
from typing import Any, Mapping
from urllib.parse import parse_qs

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.delivery import (
    CloudProject,
    ProjectIncomingEvent,
    ProjectIncomingHook,
    loop_datetime_is_unset,
)
from app.models.user import User
from app.schemas.base_role import BaseRole
from app.schemas.project_incoming_hook import (
    ProjectIncomingHookCreate,
    ProjectIncomingHookUpdate,
)
from app.services.cloud_projects.access import require_cloud_project_role
from app.services.external_events.adapters import (
    NormalizedExternalEvent,
    normalize_external_event,
)
from app.services.external_events.service import external_event_service

MAX_BODY_BYTES = 1_048_576
MAX_STORED_PAYLOAD_BYTES = 65_536
logger = logging.getLogger(__name__)


def _text(value: object) -> str:
    return value.strip() if isinstance(value, str) else ""


def parse_incoming_body(raw_body: bytes, content_type: str) -> Mapping[str, Any]:
    if len(raw_body) > MAX_BODY_BYTES:
        raise ValueError("payload exceeds 1 MiB")
    text = raw_body.decode("utf-8").strip()
    if not text:
        raise ValueError("payload is empty")
    lowered_type = content_type.lower()
    if "application/json" in lowered_type or text.startswith(("{", "[")):
        payload = json.loads(text)
        if not isinstance(payload, dict):
            raise ValueError("JSON payload must be an object")
        return payload
    if "application/x-www-form-urlencoded" in lowered_type:
        form = {key: values[-1] for key, values in parse_qs(text).items() if values}
        embedded = form.get("payload")
        if isinstance(embedded, str):
            try:
                parsed = json.loads(embedded)
            except json.JSONDecodeError:
                parsed = None
            if isinstance(parsed, dict):
                return parsed
        return form
    return {"title": text.splitlines()[0][:255], "description": text}


class ProjectIncomingHookService:
    def list(
        self, db: Session, project_id: str, user_id: int
    ) -> list[ProjectIncomingHook]:
        require_cloud_project_role(db, project_id, user_id, BaseRole.Maintainer)
        return (
            db.query(ProjectIncomingHook)
            .filter(
                ProjectIncomingHook.cloud_project_id == project_id,
                loop_datetime_is_unset(ProjectIncomingHook.deleted_at),
            )
            .order_by(ProjectIncomingHook.created_at.asc())
            .all()
        )

    def create(
        self,
        db: Session,
        project_id: str,
        user_id: int,
        values: ProjectIncomingHookCreate,
    ) -> ProjectIncomingHook:
        access = require_cloud_project_role(
            db, project_id, user_id, BaseRole.Maintainer
        )
        if access.project.task_provider != "local":
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Incoming hooks currently support Wework-managed projects only",
            )
        hook = ProjectIncomingHook(
            public_id=secrets.token_urlsafe(24),
            cloud_project_id=str(access.project.id),
            name=values.name,
            status="active",
            source="incoming",
            created_by_user_id=access.project.created_by_user_id,
            updated_by_user_id=user_id,
            metadata_json={"created_by_user_id": user_id},
        )
        db.add(hook)
        db.commit()
        db.refresh(hook)
        return hook

    def update(
        self,
        db: Session,
        project_id: str,
        hook_id: str,
        user_id: int,
        values: ProjectIncomingHookUpdate,
    ) -> ProjectIncomingHook:
        hook = self.get(db, project_id, hook_id, user_id)
        if hook.version != values.version:
            raise HTTPException(status.HTTP_409_CONFLICT, "Incoming hook was updated")
        for key, value in values.model_dump(exclude_unset=True).items():
            if key != "version":
                setattr(hook, key, value)
        hook.updated_by_user_id = user_id
        hook.version += 1
        db.commit()
        db.refresh(hook)
        return hook

    def rotate(
        self, db: Session, project_id: str, hook_id: str, user_id: int
    ) -> ProjectIncomingHook:
        hook = self.get(db, project_id, hook_id, user_id)
        hook.public_id = secrets.token_urlsafe(24)
        hook.updated_by_user_id = user_id
        hook.version += 1
        db.commit()
        db.refresh(hook)
        return hook

    def get(
        self,
        db: Session,
        project_id: str,
        hook_id: str,
        user_id: int,
    ) -> ProjectIncomingHook:
        require_cloud_project_role(db, project_id, user_id, BaseRole.Maintainer)
        hook = (
            db.query(ProjectIncomingHook)
            .filter(
                ProjectIncomingHook.id == hook_id,
                ProjectIncomingHook.cloud_project_id == project_id,
                loop_datetime_is_unset(ProjectIncomingHook.deleted_at),
            )
            .first()
        )
        if hook is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Incoming hook not found")
        return hook

    async def receive(
        self,
        db: Session,
        token: str,
        raw_body: bytes,
        content_type: str,
        headers: Mapping[str, str],
    ) -> dict[str, str | None]:
        hook = (
            db.query(ProjectIncomingHook)
            .filter(
                ProjectIncomingHook.public_id == token,
                loop_datetime_is_unset(ProjectIncomingHook.deleted_at),
            )
            .first()
        )
        if hook is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Incoming hook not found")
        if hook.status != "active":
            raise HTTPException(status.HTTP_410_GONE, "Incoming hook is disabled")
        project = db.get(CloudProject, hook.cloud_project_id)
        creator = db.get(User, hook.created_by_user_id)
        if project is None or creator is None or project.status != "active":
            raise HTTPException(status.HTTP_410_GONE, "Incoming hook is unavailable")

        try:
            payload = parse_incoming_body(raw_body, content_type)
            incoming = normalize_external_event(payload, headers)
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
            return self._record_outcome(
                db,
                hook,
                raw_body,
                headers,
                provider="unknown",
                outcome="failed",
                reason=str(exc),
            )
        if incoming is None:
            return self._record_outcome(
                db,
                hook,
                raw_body,
                headers,
                provider="unknown",
                outcome="ignored",
                reason="no supported external event detected",
                public_id=self._event_public_id(
                    hook, raw_body, headers, provider="unknown", event_id=None
                ),
            )

        event_public_id = self._event_public_id(
            hook,
            raw_body,
            headers,
            provider=incoming.provider,
            event_id=incoming.event_id,
        )
        existing = (
            db.query(ProjectIncomingEvent)
            .filter(ProjectIncomingEvent.public_id == event_public_id)
            .first()
        )
        if existing is not None:
            return {
                "status": "duplicate",
                "provider": existing.source or incoming.provider,
                "event_id": str(existing.id),
                "loop_item_id": existing.loop_item_id or None,
                "reason": None,
            }
        event = ProjectIncomingEvent(
            public_id=event_public_id,
            cloud_project_id=str(project.id),
            parent_id=str(hook.id),
            title=incoming.summary[:255],
            source=incoming.provider[:20],
            status="pending",
            created_by_user_id=creator.id,
            metadata_json=self._event_metadata(
                raw_body,
                headers,
                event=incoming,
            ),
        )
        db.add(event)
        try:
            status_value = external_event_service.route(db, hook=hook, event=incoming)
            event.status = status_value
            db.commit()
            db.refresh(event)
        except Exception:
            db.rollback()
            return self._record_outcome(
                db,
                hook,
                raw_body,
                headers,
                provider=incoming.provider,
                outcome="failed",
                reason="external event routing failed",
                public_id=event_public_id,
            )
        return {
            "status": status_value,
            "provider": incoming.provider,
            "event_id": str(event.id),
            "loop_item_id": None,
            "reason": None,
        }

    def _record_outcome(
        self,
        db: Session,
        hook: ProjectIncomingHook,
        raw_body: bytes,
        headers: Mapping[str, str],
        *,
        provider: str,
        outcome: str,
        reason: str | None,
        public_id: str | None = None,
    ) -> dict[str, str | None]:
        event_public_id = public_id or self._body_public_id(hook, raw_body)
        existing = (
            db.query(ProjectIncomingEvent)
            .filter(ProjectIncomingEvent.public_id == event_public_id)
            .first()
        )
        if existing is not None:
            return {
                "status": "duplicate",
                "provider": existing.source or provider,
                "event_id": str(existing.id),
                "loop_item_id": existing.loop_item_id or None,
                "reason": None,
            }
        event = ProjectIncomingEvent(
            public_id=event_public_id,
            cloud_project_id=str(hook.cloud_project_id),
            parent_id=str(hook.id),
            title=(reason or outcome)[:255],
            description=reason or "",
            source=provider[:20],
            status=outcome,
            created_by_user_id=hook.created_by_user_id,
            metadata_json=self._event_metadata(raw_body, headers),
        )
        db.add(event)
        db.commit()
        db.refresh(event)
        return {
            "status": outcome,
            "provider": provider,
            "event_id": str(event.id),
            "loop_item_id": None,
            "reason": reason,
        }

    @staticmethod
    def _body_public_id(hook: ProjectIncomingHook, raw_body: bytes) -> str:
        digest = hashlib.sha256(str(hook.id).encode() + b":" + raw_body).hexdigest()
        return digest[:36]

    def _event_public_id(
        self,
        hook: ProjectIncomingHook,
        raw_body: bytes,
        headers: Mapping[str, str],
        *,
        provider: str,
        event_id: str | None,
    ) -> str:
        instance_id = next(
            (
                _text(headers.get(key))
                for key in (
                    "x-github-delivery",
                    "x-gitlab-event-uuid",
                    "x-request-id",
                    "idempotency-key",
                )
                if _text(headers.get(key))
            ),
            "",
        )
        identity = instance_id or event_id or ""
        if not identity:
            return self._body_public_id(hook, raw_body)
        digest = hashlib.sha256(f"{hook.id}:{provider}:{identity}".encode()).hexdigest()
        return digest[:36]

    @staticmethod
    def _event_metadata(
        raw_body: bytes,
        headers: Mapping[str, str],
        *,
        event: NormalizedExternalEvent | None = None,
    ) -> dict[str, object]:
        metadata: dict[str, object] = {
            "content_type": headers.get("content-type", ""),
            "payload_sha256": hashlib.sha256(raw_body).hexdigest(),
            "payload_size": len(raw_body),
        }
        if len(raw_body) <= MAX_STORED_PAYLOAD_BYTES:
            metadata["payload"] = raw_body.decode("utf-8", errors="replace")
        if event is not None:
            metadata["event_type"] = event.event_type
            metadata["opaque_ref"] = event.opaque_ref
            metadata["occurred_at"] = (
                event.occurred_at.isoformat() if event.occurred_at else None
            )
            # The stored raw payload already carries the provider body; the
            # routing-only detail is kept only as a fallback for oversized
            # payloads so the row never duplicates the same data.
            if "payload" not in metadata and event.detail:
                metadata["detail"] = event.detail
            if event.source_url:
                metadata["source_url"] = event.source_url
            if event.event_id:
                metadata["event_id"] = event.event_id
        return metadata


project_incoming_hook_service = ProjectIncomingHookService()
