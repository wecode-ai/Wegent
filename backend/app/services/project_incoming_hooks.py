# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Deterministic normalization and persistence for project incoming hooks."""

import hashlib
import json
import logging
import secrets
from dataclasses import dataclass
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
from app.schemas.delivery import LoopItemCreate, LoopItemResponse
from app.schemas.project_incoming_hook import (
    ProjectIncomingHookCreate,
    ProjectIncomingHookUpdate,
)
from app.services.cloud_projects.access import require_cloud_project_role
from app.services.loop_items.provider_router import loop_item_provider_router
from app.services.loop_items.service import loop_item_service

MAX_BODY_BYTES = 1_048_576
MAX_STORED_PAYLOAD_BYTES = 65_536
logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class IncomingCandidate:
    provider: str
    title: str
    description: str
    source_url: str | None
    external_id: str | None


@dataclass(frozen=True)
class IncomingDecision:
    candidate: IncomingCandidate | None
    provider: str
    reason: str | None = None


def _mapping(value: object) -> Mapping[str, Any]:
    return value if isinstance(value, dict) else {}


def _text(value: object) -> str:
    return value.strip() if isinstance(value, str) else ""


def _first_text(payload: Mapping[str, Any], *paths: tuple[str, ...]) -> str:
    for path in paths:
        current: object = payload
        for key in path:
            if not isinstance(current, dict):
                current = None
                break
            current = current.get(key)
        value = _text(current)
        if value:
            return value
    return ""


def _github(payload: Mapping[str, Any], event_name: str) -> IncomingDecision | None:
    issue = _mapping(payload.get("issue"))
    if event_name != "issues" and not issue:
        return None
    action = _text(payload.get("action"))
    if action not in {"opened", "reopened"}:
        return IncomingDecision(
            None, "github", f"unsupported action: {action or 'unknown'}"
        )
    repository = _mapping(payload.get("repository"))
    number = issue.get("number")
    return IncomingDecision(
        IncomingCandidate(
            provider="github",
            title=_text(issue.get("title")),
            description=_text(issue.get("body")),
            source_url=_text(issue.get("html_url")) or None,
            external_id=(
                f"{_text(repository.get('full_name'))}#{number}"
                if repository.get("full_name") and number is not None
                else _text(issue.get("id")) or None
            ),
        ),
        "github",
    )


def _gitlab(payload: Mapping[str, Any], event_name: str) -> IncomingDecision | None:
    attributes = _mapping(payload.get("object_attributes"))
    if event_name != "issue hook" and payload.get("object_kind") != "issue":
        return None
    action = _text(attributes.get("action"))
    if action not in {"open", "reopen"}:
        return IncomingDecision(
            None, "gitlab", f"unsupported action: {action or 'unknown'}"
        )
    project = _mapping(payload.get("project"))
    iid = attributes.get("iid")
    return IncomingDecision(
        IncomingCandidate(
            provider="gitlab",
            title=_text(attributes.get("title")),
            description=_text(attributes.get("description")),
            source_url=_text(attributes.get("url")) or None,
            external_id=(
                f"{_text(project.get('path_with_namespace'))}#{iid}"
                if project.get("path_with_namespace") and iid is not None
                else _text(attributes.get("id")) or None
            ),
        ),
        "gitlab",
    )


def _sentry(payload: Mapping[str, Any], resource: str) -> IncomingDecision | None:
    data = _mapping(payload.get("data"))
    issue = _mapping(data.get("issue")) or _mapping(payload.get("issue"))
    if resource not in {"issue", "error"} and not issue:
        return None
    action = _text(payload.get("action"))
    if action and action not in {"created", "triggered", "resolved"}:
        return IncomingDecision(None, "sentry", f"unsupported action: {action}")
    if action == "resolved":
        return IncomingDecision(None, "sentry", "resolved event")
    return IncomingDecision(
        IncomingCandidate(
            provider="sentry",
            title=_text(issue.get("title")) or _text(issue.get("culprit")),
            description=_text(issue.get("culprit")) or _text(issue.get("metadata")),
            source_url=_text(issue.get("web_url"))
            or _text(issue.get("permalink"))
            or None,
            external_id=_text(issue.get("id")) or _text(payload.get("id")) or None,
        ),
        "sentry",
    )


def _grafana(payload: Mapping[str, Any]) -> IncomingDecision | None:
    alerts = payload.get("alerts")
    looks_like_grafana = isinstance(alerts, list) or any(
        key in payload for key in ("ruleUrl", "dashboardURL", "orgId")
    )
    if not looks_like_grafana:
        return None
    state = (_text(payload.get("status")) or _text(payload.get("state"))).lower()
    if state in {"ok", "resolved", "normal"}:
        return IncomingDecision(None, "grafana", f"resolved state: {state}")
    first_alert = _mapping(alerts[0]) if isinstance(alerts, list) and alerts else {}
    labels = _mapping(first_alert.get("labels"))
    annotations = _mapping(first_alert.get("annotations"))
    title = (
        _text(payload.get("title"))
        or _text(labels.get("alertname"))
        or _text(annotations.get("summary"))
    )
    return IncomingDecision(
        IncomingCandidate(
            provider="grafana",
            title=title,
            description=(
                _text(payload.get("message"))
                or _text(annotations.get("description"))
                or _text(annotations.get("summary"))
            ),
            source_url=(
                _text(first_alert.get("generatorURL"))
                or _text(payload.get("ruleUrl"))
                or _text(payload.get("dashboardURL"))
                or None
            ),
            external_id=(
                _text(first_alert.get("fingerprint"))
                or _text(payload.get("groupKey"))
                or None
            ),
        ),
        "grafana",
    )


def _generic(payload: Mapping[str, Any]) -> IncomingDecision:
    title = _first_text(
        payload,
        ("title",),
        ("subject",),
        ("summary",),
        ("name",),
        ("issue", "title"),
        ("alert", "title"),
        ("event", "title"),
        ("message",),
    )
    if not title:
        return IncomingDecision(None, "generic", "no deterministic title field found")
    description = _first_text(
        payload,
        ("description",),
        ("body",),
        ("details",),
        ("text",),
        ("issue", "body"),
        ("issue", "description"),
        ("alert", "description"),
        ("event", "description"),
    )
    source_url = _first_text(
        payload,
        ("url",),
        ("web_url",),
        ("html_url",),
        ("source_url",),
        ("issue", "url"),
        ("issue", "html_url"),
    )
    external_id = _first_text(
        payload,
        ("event_id",),
        ("eventId",),
        ("id",),
        ("uuid",),
        ("issue", "id"),
        ("alert", "id"),
    )
    return IncomingDecision(
        IncomingCandidate(
            provider="generic",
            title=title,
            description=description,
            source_url=source_url or None,
            external_id=external_id or None,
        ),
        "generic",
    )


def normalize_incoming_payload(
    payload: Mapping[str, Any],
    headers: Mapping[str, str],
) -> IncomingDecision:
    github_event = _text(headers.get("x-github-event")).lower()
    gitlab_event = _text(headers.get("x-gitlab-event")).lower()
    sentry_resource = _text(headers.get("sentry-hook-resource")).lower()
    for decision in (
        _github(payload, github_event),
        _gitlab(payload, gitlab_event),
        _sentry(payload, sentry_resource),
        _grafana(payload),
    ):
        if decision is not None:
            return decision
    return _generic(payload)


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
            decision = normalize_incoming_payload(payload, headers)
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

        event_public_id = self._event_public_id(hook, raw_body, headers, decision)
        existing = (
            db.query(ProjectIncomingEvent)
            .filter(ProjectIncomingEvent.public_id == event_public_id)
            .first()
        )
        if existing is not None:
            return {
                "status": "duplicate",
                "provider": existing.source or decision.provider,
                "event_id": str(existing.id),
                "loop_item_id": existing.loop_item_id or None,
                "reason": None,
            }
        if decision.candidate is None:
            return self._record_outcome(
                db,
                hook,
                raw_body,
                headers,
                provider=decision.provider,
                outcome="ignored",
                reason=decision.reason,
                public_id=event_public_id,
            )
        candidate = decision.candidate
        if not candidate.title:
            return self._record_outcome(
                db,
                hook,
                raw_body,
                headers,
                provider=candidate.provider,
                outcome="failed",
                reason="title is empty",
                public_id=event_public_id,
            )

        project_metadata = (
            project.metadata_json if isinstance(project.metadata_json, dict) else {}
        )
        board_config = project_metadata.get("board_config")
        board_config = board_config if isinstance(board_config, dict) else {}
        statuses = board_config.get("statuses")
        statuses = statuses if isinstance(statuses, list) else []
        inbox_status = (
            str(statuses[0].get("id"))
            if statuses and isinstance(statuses[0], dict)
            else None
        )
        description_parts = [candidate.description]
        if candidate.source_url:
            description_parts.append(f"来源：{candidate.source_url}")
        created = loop_item_provider_router.create(
            db,
            project,
            creator,
            LoopItemCreate(
                title=candidate.title[:255],
                description="\n\n".join(part for part in description_parts if part),
                status=inbox_status,
            ),
            automation_context={
                "trigger": "incoming_hook",
                "hook_id": str(hook.id),
                "provider": candidate.provider,
                "external_id": candidate.external_id,
                "source_url": candidate.source_url,
            },
            assign_creator_if_unassigned=False,
        )
        response = LoopItemResponse.model_validate(created.values)
        event = ProjectIncomingEvent(
            public_id=event_public_id,
            cloud_project_id=str(project.id),
            parent_id=str(hook.id),
            loop_item_id=str(created.values["id"]),
            title=candidate.title[:255],
            source=candidate.provider[:20],
            status="created",
            created_by_user_id=creator.id,
            metadata_json=self._event_metadata(
                raw_body,
                headers,
                external_id=candidate.external_id,
                source_url=candidate.source_url,
            ),
        )
        db.add(event)
        db.commit()
        db.refresh(event)

        from app.services.project_automations import (
            ProjectAutomationEvent,
            project_automation_processor,
        )

        try:
            await project_automation_processor.process(
                db,
                ProjectAutomationEvent(
                    event_type="task.created",
                    project_id=str(project.id),
                    subject_id=str(created.values["id"]),
                    source="incoming_hook",
                    actor_user_id=creator.id,
                    payload=response.model_dump(mode="json"),
                ),
            )
        except Exception:
            db.rollback()
            logger.exception(
                "Project automation processing failed after incoming hook "
                "project=%s task=%s hook=%s",
                project.id,
                created.values.get("id"),
                hook.id,
            )

        if created.internal_item is not None:
            db.refresh(created.internal_item)
            loop_item_service.response_values(db, created.internal_item, creator.id)
        return {
            "status": "created",
            "provider": candidate.provider,
            "event_id": str(event.id),
            "loop_item_id": str(created.values["id"]),
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
        decision: IncomingDecision,
    ) -> str:
        external_delivery = next(
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
        candidate_id = decision.candidate.external_id if decision.candidate else None
        identity = external_delivery or candidate_id
        if not identity:
            return self._body_public_id(hook, raw_body)
        digest = hashlib.sha256(
            f"{hook.id}:{decision.provider}:{identity}".encode()
        ).hexdigest()
        return digest[:36]

    @staticmethod
    def _event_metadata(
        raw_body: bytes,
        headers: Mapping[str, str],
        *,
        external_id: str | None = None,
        source_url: str | None = None,
    ) -> dict[str, object]:
        metadata: dict[str, object] = {
            "content_type": headers.get("content-type", ""),
            "payload_sha256": hashlib.sha256(raw_body).hexdigest(),
            "payload_size": len(raw_body),
        }
        if len(raw_body) <= MAX_STORED_PAYLOAD_BYTES:
            metadata["payload"] = raw_body.decode("utf-8", errors="replace")
        if external_id:
            metadata["external_id"] = external_id
        if source_url:
            metadata["source_url"] = source_url
        return metadata


project_incoming_hook_service = ProjectIncomingHookService()
