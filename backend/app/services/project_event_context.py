"""Extract task context from external board events."""

from dataclasses import dataclass
from typing import Any, Mapping


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
        ("external_id",),
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


def _review_event(
    payload: Mapping[str, Any], headers: Mapping[str, str]
) -> IncomingDecision | None:
    """Keep all events about one code review on its canonical artifact URL."""
    merge_request = _mapping(payload.get("merge_request"))
    if payload.get("object_kind") == "merge_request":
        merge_request = _mapping(payload.get("object_attributes"))
    pull_request = _mapping(payload.get("pull_request"))
    artifact = merge_request or pull_request
    if not artifact:
        return None
    provider = "gitlab" if merge_request else "github"
    url = _text(artifact.get("url" if merge_request else "html_url"))
    details = (
        _mapping(payload.get("object_attributes"))
        if merge_request
        else (
            _mapping(payload.get("review"))
            or _mapping(payload.get("comment"))
            or pull_request
        )
    )
    content = (
        _text(details.get("note"))
        or _text(details.get("body"))
        or _text(details.get("description"))
    )
    return IncomingDecision(
        IncomingCandidate(
            provider=provider,
            title=_text(artifact.get("title")) or "Code review event",
            description="\n\n".join(filter(None, [content, url])),
            source_url=url or None,
            external_id=url or None,
        ),
        provider,
    )


def normalize_incoming_payload(
    payload: Mapping[str, Any],
    headers: Mapping[str, str],
) -> IncomingDecision:
    github_event = _text(headers.get("x-github-event")).lower()
    gitlab_event = _text(headers.get("x-gitlab-event")).lower()
    sentry_resource = _text(headers.get("sentry-hook-resource")).lower()
    for decision in (
        _review_event(payload, headers),
        _github(payload, github_event),
        _gitlab(payload, gitlab_event),
        _sentry(payload, sentry_resource),
        _grafana(payload),
    ):
        if decision is not None:
            return decision
    return _generic(payload)
