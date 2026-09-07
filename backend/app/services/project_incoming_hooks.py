# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Durable event-subscription ingestion and processing."""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import secrets
from datetime import timedelta
from typing import Any, Mapping

from fastapi import HTTPException, status
from sqlalchemy import and_, or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.project_event_credentials import (
    decrypt_subscription_secret,
    encrypt_subscription_secret,
)
from app.db.session import SessionLocal
from app.models.delivery import (
    CloudProject,
    ProjectIncomingEvent,
    ProjectIncomingHook,
    loop_datetime_is_unset,
    loop_datetime_value_is_unset,
)
from app.schemas.base_role import BaseRole
from app.schemas.project_incoming_hook import (
    ProjectIncomingHookCreate,
    ProjectIncomingHookUpdate,
)
from app.services.cloud_projects.access import require_cloud_project_role
from app.services.project_automation_domain import ProjectAutomationEvent, utcnow
from app.services.project_event_polling import EventPollingError
from app.services.project_event_polling_service import project_event_polling_service
from app.services.project_event_sources import (
    event_source,
    normalize_observed_resource,
    normalize_webhook_events,
    normalized_event_identity,
    resource_matches,
)

MAX_BODY_BYTES = 1_048_576
MAX_STORED_PAYLOAD_BYTES = 65_536
MAX_PROCESS_ATTEMPTS = 5
logger = logging.getLogger(__name__)


def parse_incoming_body(raw_body: bytes, content_type: str) -> Mapping[str, Any]:
    if len(raw_body) > MAX_BODY_BYTES:
        raise ValueError("payload exceeds 1 MiB")
    text = raw_body.decode("utf-8").strip()
    if not text:
        raise ValueError("payload is empty")
    if "application/json" not in content_type.lower() and not text.startswith("{"):
        raise ValueError("event subscriptions require a JSON object payload")
    payload = json.loads(text)
    if not isinstance(payload, dict):
        raise ValueError("JSON payload must be an object")
    return payload


class ProjectIncomingHookService:
    """Own one-to-one observed-resource subscriptions and durable inputs."""

    def list(
        self,
        db: Session,
        project_id: str,
        user_id: int,
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

    def list_events(
        self,
        db: Session,
        project_id: str,
        hook_id: str,
        user_id: int,
        *,
        limit: int = 50,
    ) -> list[ProjectIncomingEvent]:
        self.get(db, project_id, hook_id, user_id)
        return (
            db.query(ProjectIncomingEvent)
            .filter(
                ProjectIncomingEvent.parent_id == hook_id,
                loop_datetime_is_unset(ProjectIncomingEvent.deleted_at),
            )
            .order_by(ProjectIncomingEvent.created_at.desc())
            .limit(limit)
            .all()
        )

    def create(
        self,
        db: Session,
        project_id: str,
        user_id: int,
        values: ProjectIncomingHookCreate,
        *,
        validate: bool = True,
    ) -> tuple[ProjectIncomingHook, str | None]:
        access = require_cloud_project_role(
            db,
            project_id,
            user_id,
            BaseRole.Maintainer,
        )
        definition = event_source(values.source_type)
        if values.credential_ref in {"machine-cli", "local-cli"}:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT,
                "Machine CLI credentials are reserved for branch collectors",
            )
        if values.collection_mode not in definition.collection_modes:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT,
                f"{values.source_type} does not support {values.collection_mode}",
            )
        try:
            resource = normalize_observed_resource(
                values.source_type,
                values.resource.model_dump(exclude_none=True),
            )
        except ValueError as exc:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT,
                str(exc),
            ) from exc
        if values.source_type == "wework" and resource["external_id"] != str(
            access.project.id
        ):
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT,
                "Wework subscriptions can only observe their owning project",
            )

        hook = ProjectIncomingHook(
            public_id=secrets.token_urlsafe(24),
            cloud_project_id=str(access.project.id),
            name=values.name,
            status="active",
            source=values.source_type,
            due_at=self._initial_due_at(
                values.collection_mode,
                values.poll_interval_seconds,
            ),
            created_by_user_id=user_id,
            updated_by_user_id=user_id,
            metadata_json={
                "schema_version": 1,
                "source_type": values.source_type,
                "collection_mode": values.collection_mode,
                "resource": resource,
                "credential_ref": values.credential_ref,
                "poll": self._poll_metadata(
                    values.collection_mode,
                    values.poll_interval_seconds,
                ),
                "health": {"status": "pending"},
            },
        )
        db.add(hook)
        db.flush()
        if validate and values.collection_mode in {"poll", "hybrid"}:
            try:
                project_event_polling_service.validate_configuration(db, hook)
            except EventPollingError as exc:
                raise HTTPException(
                    status.HTTP_422_UNPROCESSABLE_CONTENT,
                    str(exc),
                ) from exc
        webhook_secret = None
        if values.collection_mode in {"webhook", "hybrid"}:
            webhook_secret = secrets.token_urlsafe(32)
            hook_metadata = self.metadata(hook)
            hook_metadata["webhook_secret_encrypted"] = encrypt_subscription_secret(
                webhook_secret,
                project_id=str(access.project.id),
                subscription_id=str(hook.id),
            )
            hook.metadata_json = hook_metadata
        db.commit()
        db.refresh(hook)
        return hook, webhook_secret

    def update(
        self,
        db: Session,
        project_id: str,
        hook_id: str,
        user_id: int,
        values: ProjectIncomingHookUpdate,
    ) -> tuple[ProjectIncomingHook, str | None]:
        hook = self.get(db, project_id, hook_id, user_id, for_update=True)
        if hook.version != values.version:
            raise HTTPException(status.HTTP_409_CONFLICT, "Event subscription changed")
        hook_metadata = self.metadata(hook)
        source_type = str(hook_metadata.get("source_type") or hook.source or "")
        definition = event_source(source_type)
        collection_mode = values.collection_mode or str(
            hook_metadata.get("collection_mode") or "webhook"
        )
        if values.credential_ref in {"machine-cli", "local-cli"}:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT,
                "Machine CLI credentials are reserved for branch collectors",
            )
        if collection_mode not in definition.collection_modes:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT,
                f"{source_type} does not support {collection_mode}",
            )
        if values.resource is not None:
            try:
                hook_metadata["resource"] = normalize_observed_resource(
                    source_type,
                    values.resource.model_dump(exclude_none=True),
                )
            except ValueError as exc:
                raise HTTPException(
                    status.HTTP_422_UNPROCESSABLE_CONTENT,
                    str(exc),
                ) from exc
        if "credential_ref" in values.model_fields_set:
            hook_metadata["credential_ref"] = values.credential_ref
        hook_metadata["collection_mode"] = collection_mode
        poll = self._poll_metadata(
            collection_mode,
            values.poll_interval_seconds or self._poll_interval_seconds(hook_metadata),
            current=hook_metadata.get("poll"),
        )
        hook_metadata["poll"] = poll
        hook.metadata_json = hook_metadata
        if collection_mode in {"poll", "hybrid"}:
            try:
                project_event_polling_service.validate_configuration(db, hook)
            except EventPollingError as exc:
                raise HTTPException(
                    status.HTTP_422_UNPROCESSABLE_CONTENT,
                    str(exc),
                ) from exc
        webhook_secret = None
        if collection_mode in {"webhook", "hybrid"} and not hook_metadata.get(
            "webhook_secret_encrypted"
        ):
            webhook_secret = secrets.token_urlsafe(32)
            hook_metadata["webhook_secret_encrypted"] = encrypt_subscription_secret(
                webhook_secret,
                project_id=str(hook.cloud_project_id),
                subscription_id=str(hook.id),
            )
            hook.metadata_json = hook_metadata
        if values.name is not None:
            hook.name = values.name
        if values.status is not None:
            hook.status = values.status
        hook.due_at = (
            self._initial_due_at(
                collection_mode, self._poll_interval_seconds(hook_metadata)
            )
            if hook.status == "active"
            else None
        )
        hook.updated_by_user_id = user_id
        hook.version += 1
        db.commit()
        db.refresh(hook)
        return hook, webhook_secret

    def rotate(
        self,
        db: Session,
        project_id: str,
        hook_id: str,
        user_id: int,
    ) -> tuple[ProjectIncomingHook, str]:
        hook = self.get(db, project_id, hook_id, user_id, for_update=True)
        hook_metadata = self.metadata(hook)
        if hook_metadata.get("collection_mode") not in {"webhook", "hybrid"}:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT,
                "Only webhook subscriptions have signing secrets",
            )
        hook.public_id = secrets.token_urlsafe(24)
        webhook_secret = secrets.token_urlsafe(32)
        hook_metadata["webhook_secret_encrypted"] = encrypt_subscription_secret(
            webhook_secret,
            project_id=str(hook.cloud_project_id),
            subscription_id=str(hook.id),
        )
        hook.metadata_json = hook_metadata
        hook.updated_by_user_id = user_id
        hook.version += 1
        db.commit()
        db.refresh(hook)
        return hook, webhook_secret

    def reveal_webhook_token(
        self,
        db: Session,
        project_id: str,
        hook_id: str,
        user_id: int,
    ) -> str:
        """Return the signing token without rotating it."""

        hook = self.get(db, project_id, hook_id, user_id)
        hook_metadata = self.metadata(hook)
        encrypted = hook_metadata.get("webhook_secret_encrypted")
        if (
            hook_metadata.get("collection_mode") not in {"webhook", "hybrid"}
            or not encrypted
        ):
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT,
                "Only webhook subscriptions have signing secrets",
            )
        return decrypt_subscription_secret(
            encrypted,
            project_id=str(hook.cloud_project_id),
            subscription_id=str(hook.id),
        )

    def get(
        self,
        db: Session,
        project_id: str,
        hook_id: str,
        user_id: int,
        *,
        for_update: bool = False,
    ) -> ProjectIncomingHook:
        require_cloud_project_role(db, project_id, user_id, BaseRole.Maintainer)
        query = db.query(ProjectIncomingHook).filter(
            ProjectIncomingHook.id == hook_id,
            ProjectIncomingHook.cloud_project_id == project_id,
            loop_datetime_is_unset(ProjectIncomingHook.deleted_at),
        )
        if for_update:
            query = query.with_for_update()
        hook = query.one_or_none()
        if hook is None:
            raise HTTPException(
                status.HTTP_404_NOT_FOUND, "Event subscription not found"
            )
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
            raise HTTPException(
                status.HTTP_404_NOT_FOUND, "Event subscription not found"
            )
        if hook.status != "active":
            raise HTTPException(status.HTTP_410_GONE, "Event subscription is disabled")
        hook_metadata = self.metadata(hook)
        source_type = str(hook_metadata.get("source_type") or hook.source or "")
        collection_mode = str(hook_metadata.get("collection_mode") or "")
        if collection_mode not in {"webhook", "hybrid"}:
            raise HTTPException(
                status.HTTP_405_METHOD_NOT_ALLOWED,
                "Event subscription does not accept webhook delivery",
            )
        self._verify_signature(hook, source_type, raw_body, headers)
        try:
            payload = parse_incoming_body(raw_body, content_type)
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                str(exc),
            ) from exc
        event_public_id = self._event_public_id(
            hook,
            source_type,
            raw_body,
            headers,
        )
        existing = (
            db.query(ProjectIncomingEvent)
            .filter(ProjectIncomingEvent.public_id == event_public_id)
            .first()
        )
        if existing is not None:
            return {
                "status": "duplicate",
                "provider": existing.source or source_type,
                "event_id": str(existing.id),
                "reason": None,
            }
        event = ProjectIncomingEvent(
            public_id=event_public_id,
            cloud_project_id=str(hook.cloud_project_id),
            parent_id=str(hook.id),
            title=self._delivery_name(source_type, headers),
            source=source_type,
            status="received",
            created_by_user_id=hook.created_by_user_id,
            metadata_json=self._event_metadata(
                payload,
                raw_body,
                headers,
                collection_mode="webhook",
            ),
        )
        db.add(event)
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            existing = (
                db.query(ProjectIncomingEvent)
                .filter(ProjectIncomingEvent.public_id == event_public_id)
                .one()
            )
            return {
                "status": "duplicate",
                "provider": existing.source or source_type,
                "event_id": str(existing.id),
                "reason": None,
            }
        db.refresh(event)
        return {
            "status": "accepted",
            "provider": source_type,
            "event_id": str(event.id),
            "reason": None,
        }

    async def process_event(self, db: Session, event_id: str) -> int:
        if not self._claim_event(db, event_id):
            return 0
        return await self._process_claimed_event(db, event_id)

    def _claim_event(self, db: Session, event_id: str) -> bool:
        event = (
            db.query(ProjectIncomingEvent)
            .filter(ProjectIncomingEvent.id == event_id)
            .with_for_update()
            .one_or_none()
        )
        if event is None or event.status in {"processing", "processed", "ignored"}:
            return 0
        metadata = self.metadata(event)
        attempts = int(metadata.get("attempt_count") or 0)
        if attempts >= MAX_PROCESS_ATTEMPTS:
            return 0
        event.status = "processing"
        metadata["attempt_count"] = attempts + 1
        metadata["processing_started_at"] = utcnow().isoformat()
        event.metadata_json = metadata
        event.version += 1
        db.commit()
        return True

    async def _process_claimed_event(self, db: Session, event_id: str) -> int:
        event = db.get(ProjectIncomingEvent, event_id)
        if event is None or event.status != "processing":
            return 0
        event_parent_id = str(event.parent_id)
        metadata = self.metadata(event)
        try:
            hook = db.get(ProjectIncomingHook, event.parent_id)
            if hook is None or not loop_datetime_value_is_unset(hook.deleted_at):
                raise RuntimeError("Event subscription is unavailable")
            hook_metadata = self.metadata(hook)
            configured_resource = hook_metadata.get("resource")
            payload = metadata.get("payload")
            if not isinstance(payload, dict):
                raise RuntimeError("Incoming event payload is unavailable")
            normalized = normalize_webhook_events(
                str(hook_metadata.get("source_type") or hook.source or ""),
                payload,
                self._stored_headers(metadata),
            )
            normalized = [
                item
                for item in normalized
                if isinstance(configured_resource, dict)
                and resource_matches(configured_resource, item.resource)
            ]
            if not normalized:
                self._finish_event(
                    db,
                    event_id,
                    status_value="ignored",
                    normalized_events=[],
                    matched_runs=[],
                    reason="No supported event matched the observed resource",
                )
                return 0

            from app.services.project_automations import (
                project_automation_processor,
            )

            matched_runs = []
            for item in normalized:
                runs = await project_automation_processor.process_with_runs(
                    db,
                    ProjectAutomationEvent(
                        event_type=item.event_type,
                        project_id=str(event.cloud_project_id),
                        subject_id=item.subject_id,
                        subject_type=item.subject_type,
                        source=item.source_type,
                        actor_user_id=hook.created_by_user_id,
                        payload={
                            **item.payload,
                            "resource": item.resource,
                            "subject": item.subject,
                        },
                        event_id=(f"{hook.id}:{normalized_event_identity(item)}"),
                        subscription_id=str(hook.id),
                    ),
                )
                matched_runs.extend(runs)
            run_ids = [str(run.id) for run in matched_runs]
            unresolved_reasons = [
                run.description
                for run in matched_runs
                if run.status == "skipped"
                and isinstance(run.description, str)
                and "binding" in run.description.lower()
            ]
            self._finish_event(
                db,
                event_id,
                status_value="unresolved" if unresolved_reasons else "processed",
                normalized_events=[
                    {
                        "event_type": item.event_type,
                        "resource": item.resource,
                        "subject": item.subject,
                    }
                    for item in normalized
                ],
                matched_runs=run_ids,
                reason=(
                    "; ".join(dict.fromkeys(unresolved_reasons))
                    if unresolved_reasons
                    else None if run_ids else "No automation rule matched"
                ),
            )
            self._record_hook_health(db, str(event.parent_id), success=True)
            return len(run_ids)
        except Exception as exc:
            db.rollback()
            logger.exception("Incoming event processing failed event=%s", event_id)
            self._record_failure(db, event_id, str(exc) or "Event processing failed")
            self._record_hook_health(
                db,
                event_parent_id,
                success=False,
                error=str(exc) or "Event processing failed",
            )
            return 0

    async def ingest_internal(
        self,
        db: Session,
        event: ProjectAutomationEvent,
        *,
        automation_id: str | None = None,
    ) -> int:
        """Persist a Wework domain event before matching automation rules."""

        hook = self._ensure_internal_subscription(db, event.project_id)
        public_id = self._internal_event_public_id(hook, event)
        existing = (
            db.query(ProjectIncomingEvent)
            .filter(ProjectIncomingEvent.public_id == public_id)
            .first()
        )
        if existing is not None:
            return 0
        row = ProjectIncomingEvent(
            public_id=public_id,
            cloud_project_id=event.project_id,
            parent_id=str(hook.id),
            title=event.event_type,
            source="wework",
            status="processing",
            created_by_user_id=event.actor_user_id or hook.created_by_user_id,
            metadata_json={
                "schema_version": 1,
                "collection_mode": "internal",
                "attempt_count": 1,
                "normalized_events": [
                    {
                        "event_type": event.event_type,
                        "resource": self.metadata(hook).get("resource"),
                        "subject": {
                            "type": event.subject_type,
                            "id": event.subject_id,
                        },
                    }
                ],
                "payload": event.payload,
            },
        )
        db.add(row)
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            return 0
        from app.services.project_automations import (
            project_automation_processor,
        )

        runs = await project_automation_processor.process_with_runs(
            db,
            ProjectAutomationEvent(
                event_type=event.event_type,
                project_id=event.project_id,
                subject_id=event.subject_id,
                subject_type=event.subject_type,
                source="wework",
                actor_user_id=event.actor_user_id,
                payload=event.payload,
                event_id=public_id,
                subscription_id=str(hook.id),
            ),
            automation_id=automation_id,
        )
        self._finish_event(
            db,
            str(row.id),
            status_value="processed",
            normalized_events=self.metadata(row).get("normalized_events") or [],
            matched_runs=[str(run.id) for run in runs],
            reason=None if runs else "No automation rule matched",
        )
        return len(runs)

    async def check_pending(self, db: Session) -> int:
        now = utcnow()
        processed = 0
        for _ in range(100):
            event = (
                db.query(ProjectIncomingEvent)
                .filter(
                    or_(
                        ProjectIncomingEvent.status == "received",
                        and_(
                            ProjectIncomingEvent.status == "failed",
                            ~loop_datetime_is_unset(ProjectIncomingEvent.due_at),
                            ProjectIncomingEvent.due_at <= now,
                        ),
                    ),
                    loop_datetime_is_unset(ProjectIncomingEvent.deleted_at),
                )
                .order_by(ProjectIncomingEvent.created_at.asc())
                .with_for_update(skip_locked=True)
                .first()
            )
            if event is None:
                break
            event_id = str(event.id)
            metadata = self.metadata(event)
            attempts = int(metadata.get("attempt_count") or 0)
            if attempts >= MAX_PROCESS_ATTEMPTS:
                event.due_at = None
                db.commit()
                continue
            event.status = "processing"
            metadata["attempt_count"] = attempts + 1
            metadata["processing_started_at"] = now.isoformat()
            event.metadata_json = metadata
            event.version += 1
            db.commit()
            processed += await self._process_claimed_event(db, event_id)
        return processed

    @staticmethod
    def metadata(row: object) -> dict[str, Any]:
        value = getattr(row, "metadata_json", None)
        return dict(value) if isinstance(value, dict) else {}

    @staticmethod
    def _poll_metadata(
        collection_mode: str,
        poll_interval_seconds: int | None,
        *,
        current: object = None,
    ) -> dict[str, Any] | None:
        if collection_mode not in {"poll", "hybrid"}:
            return None
        value = dict(current) if isinstance(current, dict) else {}
        value["interval_seconds"] = poll_interval_seconds or 300
        value.setdefault("cursor", None)
        value.setdefault("failure_count", 0)
        return value

    @staticmethod
    def _poll_interval_seconds(metadata: Mapping[str, Any]) -> int | None:
        poll = metadata.get("poll")
        if not isinstance(poll, dict):
            return None
        value = poll.get("interval_seconds")
        return int(value) if isinstance(value, int) and value >= 60 else None

    @staticmethod
    def _initial_due_at(
        collection_mode: str,
        poll_interval_seconds: int | None,
    ):
        if collection_mode not in {"poll", "hybrid"}:
            return None
        return utcnow() + timedelta(seconds=poll_interval_seconds or 300)

    def _verify_signature(
        self,
        hook: ProjectIncomingHook,
        source_type: str,
        raw_body: bytes,
        headers: Mapping[str, str],
    ) -> None:
        encrypted = self.metadata(hook).get("webhook_secret_encrypted")
        try:
            secret = decrypt_subscription_secret(
                encrypted,
                project_id=str(hook.cloud_project_id),
                subscription_id=str(hook.id),
            )
        except ValueError as exc:
            raise HTTPException(
                status.HTTP_401_UNAUTHORIZED,
                "Webhook signing secret unavailable",
            ) from exc
        if source_type == "gitlab":
            valid = hmac.compare_digest(
                str(headers.get("x-gitlab-token") or ""),
                secret,
            )
        else:
            header_name = (
                "x-hub-signature-256"
                if source_type == "github"
                else "x-wegent-signature-256"
            )
            expected = (
                "sha256="
                + hmac.new(
                    secret.encode(),
                    raw_body,
                    hashlib.sha256,
                ).hexdigest()
            )
            valid = hmac.compare_digest(
                str(headers.get(header_name) or ""),
                expected,
            )
        if not valid:
            raise HTTPException(
                status.HTTP_401_UNAUTHORIZED,
                "Invalid webhook signature",
            )

    @staticmethod
    def _event_public_id(
        hook: ProjectIncomingHook,
        source_type: str,
        raw_body: bytes,
        headers: Mapping[str, str],
    ) -> str:
        delivery_id = next(
            (
                str(headers.get(key) or "").strip()
                for key in (
                    "x-github-delivery",
                    "x-gitlab-event-uuid",
                    "idempotency-key",
                    "x-request-id",
                )
                if str(headers.get(key) or "").strip()
            ),
            hashlib.sha256(raw_body).hexdigest(),
        )
        return hashlib.sha256(
            f"{hook.id}:{source_type}:{delivery_id}".encode()
        ).hexdigest()[:36]

    @staticmethod
    def _delivery_name(source_type: str, headers: Mapping[str, str]) -> str:
        event_name = (
            headers.get("x-github-event")
            or headers.get("x-gitlab-event")
            or headers.get("x-event-type")
            or "event"
        )
        return f"{source_type}: {event_name}"[:255]

    @staticmethod
    def _event_metadata(
        payload: Mapping[str, Any],
        raw_body: bytes,
        headers: Mapping[str, str],
        *,
        collection_mode: str,
    ) -> dict[str, Any]:
        return {
            "schema_version": 1,
            "collection_mode": collection_mode,
            "attempt_count": 0,
            **(
                {"payload": dict(payload)}
                if len(raw_body) <= MAX_STORED_PAYLOAD_BYTES
                else {}
            ),
            "payload_sha256": hashlib.sha256(raw_body).hexdigest(),
            "payload_size": len(raw_body),
            "headers": {
                key: value
                for key, value in {
                    "content-type": headers.get("content-type", ""),
                    "x-github-event": headers.get("x-github-event", ""),
                    "x-github-delivery": headers.get("x-github-delivery", ""),
                    "x-gitlab-event": headers.get("x-gitlab-event", ""),
                    "x-gitlab-event-uuid": headers.get("x-gitlab-event-uuid", ""),
                    "idempotency-key": headers.get("idempotency-key", ""),
                }.items()
                if value
            },
        }

    @staticmethod
    def _stored_headers(metadata: Mapping[str, Any]) -> dict[str, str]:
        headers = metadata.get("headers")
        if not isinstance(headers, dict):
            return {}
        return {
            str(key).lower(): str(value)
            for key, value in headers.items()
            if isinstance(value, str)
        }

    def _finish_event(
        self,
        db: Session,
        event_id: str,
        *,
        status_value: str,
        normalized_events: list[dict[str, Any]],
        matched_runs: list[str],
        reason: str | None,
    ) -> None:
        event = db.get(ProjectIncomingEvent, event_id)
        if event is None:
            return
        metadata = self.metadata(event)
        metadata.update(
            {
                "normalized_events": normalized_events,
                "matched_runs": matched_runs,
                "reason": reason,
                "processed_at": utcnow().isoformat(),
            }
        )
        metadata.pop("last_error", None)
        event.metadata_json = metadata
        event.status = status_value
        event.description = reason or ""
        event.due_at = None
        event.version += 1
        db.commit()

    def _record_failure(self, db: Session, event_id: str, error: str) -> None:
        event = db.get(ProjectIncomingEvent, event_id)
        if event is None:
            return
        metadata = self.metadata(event)
        attempts = int(metadata.get("attempt_count") or 1)
        metadata["last_error"] = error
        metadata["reason"] = error
        event.metadata_json = metadata
        event.description = error
        event.status = "failed"
        event.due_at = (
            None
            if attempts >= MAX_PROCESS_ATTEMPTS
            else utcnow() + timedelta(seconds=min(60 * (2 ** (attempts - 1)), 3600))
        )
        event.version += 1
        db.commit()

    def _record_hook_health(
        self,
        db: Session,
        hook_id: str,
        *,
        success: bool,
        error: str | None = None,
    ) -> None:
        hook = db.get(ProjectIncomingHook, hook_id)
        if hook is None:
            return
        metadata = self.metadata(hook)
        health = (
            dict(metadata.get("health"))
            if isinstance(metadata.get("health"), dict)
            else {}
        )
        health.update(
            {
                "status": "healthy" if success else "error",
                "checked_at": utcnow().isoformat(),
            }
        )
        if error:
            health["last_error"] = error
        else:
            health.pop("last_error", None)
        metadata["health"] = health
        metadata["last_event_at"] = utcnow().isoformat()
        hook.metadata_json = metadata
        hook.version += 1
        db.commit()

    def _ensure_internal_subscription(
        self,
        db: Session,
        project_id: str,
    ) -> ProjectIncomingHook:
        hook = (
            db.query(ProjectIncomingHook)
            .filter(
                ProjectIncomingHook.cloud_project_id == project_id,
                ProjectIncomingHook.source == "wework",
                loop_datetime_is_unset(ProjectIncomingHook.deleted_at),
            )
            .first()
        )
        if hook is not None:
            return hook
        project = db.get(CloudProject, project_id)
        if project is None:
            raise RuntimeError("Cloud project is unavailable")
        hook = ProjectIncomingHook(
            public_id=hashlib.sha256(
                f"wework-project:{project_id}".encode()
            ).hexdigest()[:36],
            cloud_project_id=project_id,
            name="Wework",
            status="active",
            source="wework",
            created_by_user_id=project.created_by_user_id,
            updated_by_user_id=project.created_by_user_id,
            metadata_json={
                "schema_version": 1,
                "source_type": "wework",
                "collection_mode": "internal",
                "resource": normalize_observed_resource(
                    "wework",
                    {
                        "resource_type": "project_space",
                        "external_id": project_id,
                        "display_name": project.name,
                    },
                ),
                "health": {"status": "healthy"},
            },
        )
        db.add(hook)
        db.commit()
        db.refresh(hook)
        return hook

    @staticmethod
    def _internal_event_public_id(
        hook: ProjectIncomingHook,
        event: ProjectAutomationEvent,
    ) -> str:
        identity = event.event_id or json.dumps(
            {
                "type": event.event_type,
                "subject": event.subject_id,
                "payload": event.payload,
            },
            ensure_ascii=False,
            sort_keys=True,
            default=str,
        )
        return hashlib.sha256(f"{hook.id}:{identity}".encode()).hexdigest()[:36]


def process_project_incoming_event_sync(event_id: str) -> int:
    with SessionLocal() as db:
        return asyncio.run(project_incoming_hook_service.process_event(db, event_id))


def check_pending_project_incoming_events_sync() -> int:
    with SessionLocal() as db:
        return asyncio.run(project_incoming_hook_service.check_pending(db))


project_incoming_hook_service = ProjectIncomingHookService()
