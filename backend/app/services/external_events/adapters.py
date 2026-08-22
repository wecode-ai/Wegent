# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Normalize provider webhook payloads into the unified external event shape.

The unified shape carries exactly the fields the routing layer consumes
(provider, opaque reference, event type, summary) plus the auxiliary fields
that are only persisted for audit and future use. Adapters own the meaning of
their opaque references; the routing layer treats them as opaque keys.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Mapping
from urllib.parse import unquote


@dataclass(frozen=True)
class ProviderEventType:
    event_type: str
    category: str
    description: str
    # Delivery policy declared by the event type, not chosen per rule.
    # ``window_seconds`` is a trailing-edge time window: events of the same
    # type arriving inside it merge into one repair round that fires when the
    # window expires (None = leading edge, the first event fires immediately).
    # ``merge_while_running`` coalesces events that arrive while a repair round
    # is running into one follow-up round (False = one round per event, serially).
    window_seconds: int | None = None
    merge_while_running: bool = False


GITLAB_EVENT_MERGED = "merged"
GITLAB_EVENT_CI_FAILED = "ci_failed"
GITLAB_EVENT_REVIEW_COMMENT = "review_comment"
# Review comments arrive in bursts (a reviewer posts several notes at once);
# the adapter marks them with a short aggregation window so the wait node
# merges a burst into one repair round instead of triggering per comment.
GITLAB_COMMENT_AGGREGATE_WINDOW_SECONDS = 5

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
        merge_while_running=True,
    ),
    ProviderEventType(
        event_type=GITLAB_EVENT_REVIEW_COMMENT,
        category="review",
        description="A new comment was added to the merge request",
        window_seconds=GITLAB_COMMENT_AGGREGATE_WINDOW_SECONDS,
        merge_while_running=True,
    ),
)

PROVIDER_EVENT_TYPES: dict[str, tuple[ProviderEventType, ...]] = {
    "gitlab": GITLAB_EVENT_TYPES,
}


def event_type_policy(provider: str, event_type: str) -> ProviderEventType | None:
    """Resolve the declared delivery policy for one provider event type.

    Event types outside the catalog (generic envelope providers and custom
    types) have no declaration and fall back to the default policy: leading
    edge, one round per event, serially.
    """

    for candidate in PROVIDER_EVENT_TYPES.get(provider, ()):
        if candidate.event_type == event_type:
            return candidate
    return None


# Providers with a native payload adapter. Every other provider string is a
# generic envelope provider: its webhook must declare the same provider in the
# x-event-provider header and carry opaque_ref + event_type in the payload.
# Adding a native adapter means adding its event types to PROVIDER_EVENT_TYPES;
# everything else is generic by definition, with no per-provider special cases.
GENERIC_PROVIDER = "generic"
NATIVE_PROVIDERS = frozenset(PROVIDER_EVENT_TYPES)


def provider_kind(provider: str) -> str:
    """Classify a provider string as "native" or "generic"."""

    normalized = str(provider or "").strip().lower()
    return "native" if normalized in NATIVE_PROVIDERS else "generic"


@dataclass(frozen=True)
class ProviderReferenceAdapter:
    """How one provider turns a delivered reference into an opaque routing key.

    ``reference_kind`` is the delivery fulfillment kind that carries the
    reference (for example ``pull_request`` for GitLab). The routing layer
    never interprets the opaque reference itself; it asks the adapter to derive
    it from the typed delivery, so the opaque reference format is owned by the
    provider and never has to appear in a prompt. A provider without an adapter
    (or with ``reference_kind`` None) has no automatic reference path: its
    opaque references are always registered explicitly through the manual tool.

    Adding a new provider adapter is one self-contained class plus one registry
    entry; no routing, delivery, or workflow code changes.
    """

    provider: str
    reference_kind: str | None
    reference_name: str
    reference_description: str
    opaque_ref_format: str
    opaque_ref_example: str

    def extract_opaque_refs(self, fulfillment: Mapping[str, Any]) -> tuple[str, ...]:
        raise NotImplementedError


_GITLAB_MR_URL = re.compile(r"^https?://[^/]+/(.+?)/(?:-/)?merge_requests/\d+/?$")


class GitLabReferenceAdapter(ProviderReferenceAdapter):
    def extract_opaque_refs(self, fulfillment: Mapping[str, Any]) -> tuple[str, ...]:
        if fulfillment.get("kind") != "pull_request":
            return ()
        url = _text(fulfillment.get("url"))
        number = fulfillment.get("number")
        if not url or number is None:
            return ()
        path = self._project_path(url)
        if not path:
            return ()
        return (f"{path}!{number}",)

    @staticmethod
    def _project_path(url: str) -> str | None:
        match = _GITLAB_MR_URL.match(url)
        if not match:
            return None
        return unquote(match.group(1))


# The reference adapter registry is the single extension point for automatic
# bindings: one entry per provider, everything else is generic machinery.
PROVIDER_REFERENCE_ADAPTERS: dict[str, ProviderReferenceAdapter] = {
    "gitlab": GitLabReferenceAdapter(
        provider="gitlab",
        reference_kind="pull_request",
        reference_name="GitLab MR",
        reference_description=(
            "交付 GitLab Merge Request 引用(url + number)。交付完成后系统"
            "自动用它登记等待事件，无需手动调用登记工具。"
        ),
        opaque_ref_format="group/project!iid",
        opaque_ref_example="group/subgroup/project!123",
    ),
}


def provider_reference_adapter(provider: str) -> ProviderReferenceAdapter | None:
    """Return the reference adapter for one provider, or None for generic ones."""

    return PROVIDER_REFERENCE_ADAPTERS.get(str(provider or "").strip().lower())


def provider_event_catalog() -> list[dict[str, object]]:
    """Return the event types each provider adapter can produce.

    Each entry also carries the provider's automatic-reference metadata so the
    workflow editor can show what an upstream stage must deliver and in what
    opaque reference format.
    """

    rows: list[dict[str, object]] = []
    for provider, event_types in PROVIDER_EVENT_TYPES.items():
        adapter = provider_reference_adapter(provider)
        for event_type in event_types:
            rows.append(
                {
                    "provider": provider,
                    "event_type": event_type.event_type,
                    "category": event_type.category,
                    "description": event_type.description,
                    "window_seconds": event_type.window_seconds,
                    "merge_while_running": event_type.merge_while_running,
                    "reference_kind": adapter.reference_kind if adapter else "",
                    "reference_name": adapter.reference_name if adapter else "",
                    "opaque_ref_format": adapter.opaque_ref_format if adapter else "",
                    "opaque_ref_example": adapter.opaque_ref_example if adapter else "",
                }
            )
    return rows


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


def external_event_dict(event: NormalizedExternalEvent) -> dict[str, Any]:
    """Serialize one normalized event into the buffer and audit shapes."""

    return {
        "provider": event.provider,
        "opaque_ref": event.opaque_ref,
        "event_type": event.event_type,
        "event_id": event.event_id,
        "summary": event.summary,
        "source_url": event.source_url,
        "occurred_at": event.occurred_at.isoformat() if event.occurred_at else None,
        "detail": event.detail,
    }


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
        if not opaque_ref:
            return None
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
        if attributes.get("system"):
            return None
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
