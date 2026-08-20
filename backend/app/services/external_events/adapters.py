# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Normalize provider webhook payloads into the unified external event shape.

The unified shape carries exactly the fields the routing layer consumes
(provider, opaque reference, event type, summary) plus the auxiliary fields
that are only persisted for audit and future use. Adapters own the meaning of
their opaque references; the routing layer treats them as opaque keys.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Mapping


@dataclass(frozen=True)
class ProviderEventType:
    event_type: str
    category: str
    description: str


GITLAB_EVENT_MERGED = "merged"
GITLAB_EVENT_CI_FAILED = "ci_failed"
GITLAB_EVENT_REVIEW_COMMENT = "review_comment"

GITLAB_EVENT_TYPES = (
    ProviderEventType(
        event_type=GITLAB_EVENT_MERGED,
        category="lifecycle",
        description="The merge request was merged",
    ),
    ProviderEventType(
        event_type=GITLAB_EVENT_CI_FAILED,
        category="ci",
        description="A pipeline for the merge request failed",
    ),
    ProviderEventType(
        event_type=GITLAB_EVENT_REVIEW_COMMENT,
        category="review",
        description="A new comment was added to the merge request",
    ),
)

PROVIDER_EVENT_TYPES: dict[str, tuple[ProviderEventType, ...]] = {
    "gitlab": GITLAB_EVENT_TYPES,
}


def provider_event_catalog() -> list[dict[str, str]]:
    """Return the event types each provider adapter can produce."""

    return [
        {
            "provider": provider,
            "event_type": event_type.event_type,
            "category": event_type.category,
            "description": event_type.description,
        }
        for provider, event_types in PROVIDER_EVENT_TYPES.items()
        for event_type in event_types
    ]


@dataclass(frozen=True)
class NormalizedExternalEvent:
    provider: str
    opaque_ref: str
    event_type: str
    event_id: str | None
    summary: str
    source_url: str | None
    occurred_at: datetime | None
    detail: dict[str, Any]


def _mapping(value: object) -> Mapping[str, Any]:
    return value if isinstance(value, dict) else {}


def _text(value: object) -> str:
    return value.strip() if isinstance(value, str) else ""


def _gitlab_mr_ref(project: Mapping[str, Any], mr: Mapping[str, Any]) -> str:
    path = _text(project.get("path_with_namespace"))
    iid = mr.get("iid")
    return f"{path}!{iid}" if path and iid is not None else ""


def _gitlab(
    payload: Mapping[str, Any], headers: Mapping[str, str]
) -> NormalizedExternalEvent | None:
    kind = _text(payload.get("object_kind"))
    header_kind = _text(headers.get("x-gitlab-event")).casefold()
    if kind not in {"merge_request", "pipeline", "note"} and header_kind not in {
        "merge request hook",
        "pipeline hook",
        "note hook",
    }:
        return None
    project = _mapping(payload.get("project"))
    attributes = _mapping(payload.get("object_attributes"))
    if kind == "merge_request" and _text(attributes.get("action")) == "merge":
        opaque_ref = _gitlab_mr_ref(project, attributes)
        if not opaque_ref:
            return None
        return NormalizedExternalEvent(
            provider="gitlab",
            opaque_ref=opaque_ref,
            event_type=GITLAB_EVENT_MERGED,
            event_id=str(attributes.get("id") or "") or None,
            summary=f"MR !{attributes.get('iid')} merged",
            source_url=_text(attributes.get("url")) or None,
            occurred_at=_gitlab_occurred_at(attributes),
            detail={"kind": "merge_request", "merge_request": dict(attributes)},
        )
    if kind == "pipeline" and _text(attributes.get("status")) == "failed":
        mr = _mapping(payload.get("merge_request")) or _mapping(
            attributes.get("merge_request")
        )
        opaque_ref = _gitlab_mr_ref(project, mr)
        if not opaque_ref:
            opaque_ref = _text(project.get("path_with_namespace"))
        return NormalizedExternalEvent(
            provider="gitlab",
            opaque_ref=opaque_ref,
            event_type=GITLAB_EVENT_CI_FAILED,
            event_id=str(attributes.get("id") or "") or None,
            summary=f"Pipeline #{attributes.get('id')} failed",
            source_url=_text(project.get("web_url")) or None,
            occurred_at=_gitlab_occurred_at(attributes),
            detail={"kind": "pipeline", "pipeline": dict(attributes)},
        )
    if kind == "note" and _text(attributes.get("noteable_type")) == "MergeRequest":
        mr = _mapping(payload.get("merge_request"))
        opaque_ref = _gitlab_mr_ref(project, mr)
        if not opaque_ref:
            return None
        author = _mapping(payload.get("user"))
        return NormalizedExternalEvent(
            provider="gitlab",
            opaque_ref=opaque_ref,
            event_type=GITLAB_EVENT_REVIEW_COMMENT,
            event_id=str(attributes.get("id") or "") or None,
            summary=f"New comment by {_text(author.get('username')) or 'user'}",
            source_url=_text(attributes.get("url")) or None,
            occurred_at=_gitlab_occurred_at(attributes),
            detail={"kind": "note", "note": dict(attributes)},
        )
    return None


def _gitlab_occurred_at(attributes: Mapping[str, Any]) -> datetime | None:
    value = _text(attributes.get("updated_at")) or _text(attributes.get("created_at"))
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def _generic(
    payload: Mapping[str, Any], provider: str
) -> NormalizedExternalEvent | None:
    opaque_ref = _text(payload.get("opaque_ref")) or _text(payload.get("reference"))
    event_type = _text(payload.get("event_type"))
    if not opaque_ref or not event_type:
        return None
    summary = _text(payload.get("summary")) or f"{event_type} on {opaque_ref}"
    event_id = _text(payload.get("event_id")) or None
    source_url = _text(payload.get("source_url")) or None
    occurred_at_value = payload.get("occurred_at")
    occurred_at: datetime | None = None
    if isinstance(occurred_at_value, str) and occurred_at_value:
        try:
            occurred_at = datetime.fromisoformat(
                occurred_at_value.replace("Z", "+00:00")
            )
        except ValueError:
            occurred_at = None
    return NormalizedExternalEvent(
        provider=provider,
        opaque_ref=opaque_ref,
        event_type=event_type,
        event_id=event_id,
        summary=summary,
        source_url=source_url,
        occurred_at=occurred_at,
        detail={"payload": dict(payload)},
    )


def normalize_external_event(
    payload: Mapping[str, Any],
    headers: Mapping[str, str],
) -> NormalizedExternalEvent | None:
    """Return the unified event for one inbound payload, or None when ignored."""

    gitlab_event = _gitlab(payload, headers)
    if gitlab_event is not None:
        return gitlab_event
    provider = _text(headers.get("x-event-provider")) or "generic"
    return _generic(payload, provider)
