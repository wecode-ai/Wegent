# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Event-source registry and vendor payload normalization."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping
from urllib.parse import urlparse

COLLECTION_MODES = {"webhook", "poll", "internal", "hybrid"}
EXECUTION_TARGETS = {"existing_issue", "continue_binding", "create_issue"}


@dataclass(frozen=True)
class EventSourceDefinition:
    source_type: str
    collection_modes: tuple[str, ...]
    resource_types: tuple[str, ...]
    event_types: tuple[str, ...]
    execution_targets: tuple[str, ...]
    name_key: str
    description_key: str


@dataclass(frozen=True)
class NormalizedProjectEvent:
    event_type: str
    source_type: str
    resource: dict[str, Any]
    subject: dict[str, Any]
    payload: dict[str, Any]

    @property
    def subject_id(self) -> str:
        value = self.subject.get("id")
        return str(value) if value is not None else ""

    @property
    def subject_type(self) -> str:
        return str(self.subject.get("type") or "unknown")


_SOURCES = {
    "github": EventSourceDefinition(
        source_type="github",
        collection_modes=("webhook", "poll", "hybrid"),
        resource_types=("repository",),
        event_types=(
            "change_request.checks_failed",
            "change_request.merge_conflict",
            "change_request.review_submitted",
            "change_request.comment_created",
            "change_request.merged",
        ),
        execution_targets=("continue_binding", "create_issue"),
        name_key="event_sources.github.name",
        description_key="event_sources.github.description",
    ),
    "gitlab": EventSourceDefinition(
        source_type="gitlab",
        collection_modes=("webhook", "poll", "hybrid"),
        resource_types=("project",),
        event_types=(
            "change_request.checks_failed",
            "change_request.merge_conflict",
            "change_request.comment_created",
            "change_request.merged",
        ),
        execution_targets=("continue_binding", "create_issue"),
        name_key="event_sources.gitlab.name",
        description_key="event_sources.gitlab.description",
    ),
    "wework": EventSourceDefinition(
        source_type="wework",
        collection_modes=("internal",),
        resource_types=("project_space",),
        event_types=("task.created", "task.status_changed"),
        execution_targets=("existing_issue",),
        name_key="event_sources.wework.name",
        description_key="event_sources.wework.description",
    ),
    "generic": EventSourceDefinition(
        source_type="generic",
        collection_modes=("webhook",),
        resource_types=("endpoint",),
        event_types=("document.changed",),
        execution_targets=("create_issue",),
        name_key="event_sources.generic.name",
        description_key="event_sources.generic.description",
    ),
}


def event_source(source_type: str) -> EventSourceDefinition:
    try:
        return _SOURCES[source_type]
    except KeyError as exc:
        raise ValueError(f"Unknown event source: {source_type}") from exc


def event_source_catalog() -> list[dict[str, Any]]:
    return [
        {
            "source_type": definition.source_type,
            "collection_modes": list(definition.collection_modes),
            "resource_types": list(definition.resource_types),
            "event_types": list(definition.event_types),
            "execution_targets": list(definition.execution_targets),
            "name_key": definition.name_key,
            "description_key": definition.description_key,
        }
        for definition in _SOURCES.values()
    ]


def supported_event_type(event_type: str) -> bool:
    return any(event_type in source.event_types for source in _SOURCES.values())


def normalize_observed_resource(
    source_type: str,
    resource: Mapping[str, Any],
) -> dict[str, Any]:
    definition = event_source(source_type)
    # Each event source observes exactly one resource type, so it is written
    # into the source definition and never chosen by the caller. A supplied
    # value is still validated against the source to reject mismatches.
    resource_type = _text(resource.get("resource_type")) or definition.resource_types[0]
    if resource_type not in definition.resource_types:
        raise ValueError(
            f"{source_type} does not support resource type {resource_type or 'unknown'}"
        )
    instance_url = _normalized_instance_url(resource.get("instance_url"))
    path = _normalized_path(resource.get("path"))
    url = _text(resource.get("url"))
    external_id = _text(resource.get("external_id"))
    display_name = _text(resource.get("display_name"))

    if url:
        parsed = urlparse(url)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ValueError("Observed resource URL must use HTTP or HTTPS")
        instance_url = (
            instance_url or f"{parsed.scheme.lower()}://{parsed.netloc.lower()}"
        )
        path = path or _normalized_path(parsed.path)

    if source_type == "github":
        instance_url = instance_url or "https://github.com"
        if resource_type == "repository":
            path = _repository_path(path)
            external_id = external_id or path.lower()
    elif source_type == "gitlab":
        instance_url = instance_url or "https://gitlab.com"
        if resource_type == "project":
            path = _repository_path(path)
            external_id = external_id or path
    elif source_type == "wework":
        if not external_id:
            raise ValueError("Wework project-space resource requires external_id")
    elif not external_id:
        external_id = path or url

    if not external_id:
        raise ValueError("Observed resource requires a stable external_id")
    return {
        "resource_type": resource_type,
        "instance_url": instance_url,
        "external_id": external_id,
        "path": path,
        "url": url or _resource_url(instance_url, path),
        "display_name": display_name or path or external_id,
    }


def resource_matches(
    configured: Mapping[str, Any],
    observed: Mapping[str, Any],
) -> bool:
    if _text(configured.get("resource_type")) != _text(observed.get("resource_type")):
        return False
    configured_instance = _normalized_instance_url(configured.get("instance_url"))
    observed_instance = _normalized_instance_url(observed.get("instance_url"))
    if (
        configured_instance
        and observed_instance
        and configured_instance != observed_instance
    ):
        # A local mock API host represents the same repository identity used
        # for the vendor web URL; port changes between test runs must not
        # make polling events appear to come from another instance.
        if _is_private_instance_url(configured_instance) and _is_private_instance_url(
            observed_instance
        ):
            return _normalized_path(configured.get("path")) == _normalized_path(
                observed.get("path")
            )
        return False
    configured_id = _text(configured.get("external_id"))
    observed_id = _text(observed.get("external_id"))
    configured_path = _normalized_path(configured.get("path"))
    observed_path = _normalized_path(observed.get("path"))
    if configured_path and configured_path == observed_path:
        return True
    if configured_id and observed_id:
        return configured_id.lower() == observed_id.lower()
    return False


def _is_private_instance_url(value: str) -> bool:
    try:
        host = urlparse(value).hostname or ""
    except ValueError:
        return False
    return host in {
        "localhost",
        "127.0.0.1",
        "0.0.0.0",
        "::1",
    } or host.endswith(".localhost")


def normalize_webhook_events(
    source_type: str,
    payload: Mapping[str, Any],
    headers: Mapping[str, str],
) -> list[NormalizedProjectEvent]:
    if source_type == "github":
        return _github_events(payload, headers)
    if source_type == "gitlab":
        return _gitlab_events(payload, headers)
    if source_type == "generic":
        return _generic_events(payload)
    return []


def normalized_event_identity(event: NormalizedProjectEvent) -> str:
    """Return a stable business identity shared by webhook and polling inputs."""

    payload = event.payload
    raw_event = _text(payload.get("raw_event"))
    object_id = ""
    version = ""
    for key in ("check", "review", "comment", "pipeline", "note"):
        value = _mapping(payload.get(key))
        if value.get("id") is not None:
            object_id = f"{key}:{value['id']}"
            version = _text(
                value.get("conclusion")
                or value.get("status")
                or value.get("updated_at")
                or value.get("submitted_at")
            )
            break
    if not object_id:
        object_id = f"subject:{event.subject_id}"
        version = _text(
            payload.get("mergeable_state")
            or payload.get("merge_status")
            or event.subject.get("head_commit")
        )
    identity = "|".join(
        (
            event.source_type,
            event.event_type,
            raw_event,
            object_id,
            version,
        )
    )
    import hashlib

    return hashlib.sha256(identity.encode()).hexdigest()[:36]


def _github_events(
    payload: Mapping[str, Any],
    headers: Mapping[str, str],
) -> list[NormalizedProjectEvent]:
    event_name = _text(headers.get("x-github-event")).lower()
    repository = _mapping(payload.get("repository"))
    resource = _github_resource(repository)
    if not resource:
        return []

    if event_name in {"check_run", "check_suite", "workflow_run"}:
        check = _mapping(payload.get(event_name))
        conclusion = _text(check.get("conclusion")).lower()
        status = _text(check.get("status")).lower()
        if status and status != "completed":
            return []
        if conclusion not in {"failure", "timed_out", "cancelled", "action_required"}:
            return []
        pull_requests = check.get("pull_requests")
        subjects = (
            [
                _github_change_request(resource, candidate)
                for candidate in pull_requests
                if isinstance(candidate, dict)
            ]
            if isinstance(pull_requests, list)
            else []
        )
        subjects = [subject for subject in subjects if subject]
        if not subjects:
            subjects = [
                {
                    "type": "change_request",
                    "id": _text(check.get("head_sha")) or _text(check.get("id")),
                    "provider": "github",
                    "instance_url": resource["instance_url"],
                    "repository": resource["path"],
                    "head_commit": _text(check.get("head_sha")) or None,
                    "head_branch": _text(check.get("head_branch")) or None,
                }
            ]
        return [
            NormalizedProjectEvent(
                event_type="change_request.checks_failed",
                source_type="github",
                resource=resource,
                subject=subject,
                payload={
                    "raw_event": event_name,
                    "action": _text(payload.get("action")),
                    "conclusion": conclusion,
                    "check": dict(check),
                },
            )
            for subject in subjects
            if subject.get("id")
        ]

    if event_name == "pull_request":
        change_request = _mapping(payload.get("pull_request"))
        if (
            _text(payload.get("action")).lower() == "closed"
            and change_request.get("merged") is True
        ):
            subject = _github_change_request(resource, change_request)
            return (
                [
                    NormalizedProjectEvent(
                        event_type="change_request.merged",
                        source_type="github",
                        resource=resource,
                        subject=subject,
                        payload={
                            "raw_event": event_name,
                            "action": "closed",
                            "merged_at": change_request.get("merged_at"),
                        },
                    )
                ]
                if subject
                else []
            )
        mergeable_state = _text(change_request.get("mergeable_state")).lower()
        if change_request.get("mergeable") is not False and mergeable_state not in {
            "dirty",
            "conflicting",
        }:
            return []
        subject = _github_change_request(resource, change_request)
        return (
            [
                NormalizedProjectEvent(
                    event_type="change_request.merge_conflict",
                    source_type="github",
                    resource=resource,
                    subject=subject,
                    payload={
                        "raw_event": event_name,
                        "action": _text(payload.get("action")),
                        "mergeable_state": mergeable_state,
                    },
                )
            ]
            if subject
            else []
        )

    if event_name == "pull_request_review":
        review = _mapping(payload.get("review"))
        if _text(payload.get("action")).lower() != "submitted":
            return []
        subject = _github_change_request(
            resource, _mapping(payload.get("pull_request"))
        )
        return _change_request_event(
            "change_request.review_submitted",
            "github",
            resource,
            subject,
            {
                "raw_event": event_name,
                "review": dict(review),
                "author": _github_user(review.get("user")),
            },
        )

    if event_name == "pull_request_review_comment":
        if _text(payload.get("action")).lower() != "created":
            return []
        subject = _github_change_request(
            resource, _mapping(payload.get("pull_request"))
        )
        comment = _mapping(payload.get("comment"))
        return _change_request_event(
            "change_request.comment_created",
            "github",
            resource,
            subject,
            {
                "raw_event": event_name,
                "comment": dict(comment),
                "author": _github_user(comment.get("user")),
            },
        )

    if event_name == "issue_comment":
        issue = _mapping(payload.get("issue"))
        if _text(payload.get("action")).lower() != "created" or not isinstance(
            issue.get("pull_request"), dict
        ):
            return []
        subject = _github_change_request(resource, issue)
        comment = _mapping(payload.get("comment"))
        return _change_request_event(
            "change_request.comment_created",
            "github",
            resource,
            subject,
            {
                "raw_event": event_name,
                "comment": dict(comment),
                "author": _github_user(comment.get("user")),
            },
        )
    return []


def _gitlab_events(
    payload: Mapping[str, Any],
    headers: Mapping[str, str],
) -> list[NormalizedProjectEvent]:
    event_name = (
        _text(headers.get("x-gitlab-event")) or _text(payload.get("object_kind"))
    ).lower()
    resource = _gitlab_resource(_mapping(payload.get("project")))
    if not resource:
        return []

    if event_name in {"pipeline hook", "pipeline"}:
        attributes = _mapping(payload.get("object_attributes"))
        if _text(attributes.get("status")).lower() not in {
            "failed",
            "canceled",
        }:
            return []
        merge_request = _mapping(payload.get("merge_request"))
        subject = _gitlab_change_request(resource, merge_request)
        if not subject:
            subject = {
                "type": "change_request",
                "id": _text(attributes.get("sha")) or _text(attributes.get("id")),
                "provider": "gitlab",
                "instance_url": resource["instance_url"],
                "repository": resource["path"],
                "head_commit": _text(attributes.get("sha")) or None,
                "head_branch": _text(attributes.get("ref")) or None,
            }
        return _change_request_event(
            "change_request.checks_failed",
            "gitlab",
            resource,
            subject,
            {"raw_event": event_name, "pipeline": dict(attributes)},
        )

    if event_name in {"merge request hook", "merge_request"}:
        attributes = _mapping(payload.get("object_attributes"))
        if _text(attributes.get("state")).lower() == "merged":
            subject = _gitlab_change_request(resource, attributes)
            return (
                [
                    NormalizedProjectEvent(
                        event_type="change_request.merged",
                        source_type="gitlab",
                        resource=resource,
                        subject=subject,
                        payload={
                            "raw_event": event_name,
                            "action": "merge",
                            "merged_at": attributes.get("merged_at"),
                        },
                    )
                ]
                if subject
                else []
            )
        merge_status = (
            _text(attributes.get("detailed_merge_status"))
            or _text(attributes.get("merge_status"))
        ).lower()
        if merge_status not in {"cannot_be_merged", "conflict", "conflicting"}:
            return []
        subject = _gitlab_change_request(resource, attributes)
        return _change_request_event(
            "change_request.merge_conflict",
            "gitlab",
            resource,
            subject,
            {"raw_event": event_name, "merge_status": merge_status},
        )

    if event_name in {"note hook", "note"}:
        merge_request = _mapping(payload.get("merge_request"))
        if not merge_request:
            return []
        note = _mapping(payload.get("object_attributes"))
        if note.get("system") is True:
            return []
        action = _text(note.get("action") or payload.get("action")).lower()
        if action and action != "create":
            return []
        subject = _gitlab_change_request(resource, merge_request)
        return _change_request_event(
            "change_request.comment_created",
            "gitlab",
            resource,
            subject,
            {
                "raw_event": event_name,
                "note": dict(note),
                "author": _gitlab_author(payload.get("user") or note.get("author")),
            },
        )

    return []


def _generic_events(
    payload: Mapping[str, Any],
) -> list[NormalizedProjectEvent]:
    event_type = _text(payload.get("event_type") or payload.get("eventType"))
    if event_type != "document.changed":
        return []
    resource_value = _mapping(payload.get("resource"))
    try:
        resource = normalize_observed_resource("generic", resource_value)
    except ValueError:
        return []
    subject_value = _mapping(payload.get("subject"))
    subject_id = _text(subject_value.get("id")) or _text(payload.get("version"))
    if not subject_id:
        return []
    return [
        NormalizedProjectEvent(
            event_type=event_type,
            source_type="generic",
            resource=resource,
            subject={
                **dict(subject_value),
                "type": _text(subject_value.get("type")) or "document",
                "id": subject_id,
            },
            payload=dict(payload),
        )
    ]


def _github_resource(repository: Mapping[str, Any]) -> dict[str, Any]:
    base_repository = _mapping(repository.get("repo"))
    path = _text(repository.get("full_name")) or _text(base_repository.get("full_name"))
    url = _text(repository.get("html_url"))
    base_url = _text(base_repository.get("html_url"))
    instance_url = (
        _instance_from_url(url) or _instance_from_url(base_url) or "https://github.com"
    )
    if not path:
        return {}
    return {
        "resource_type": "repository",
        "instance_url": instance_url,
        "external_id": _text(repository.get("id")) or path.lower(),
        "path": path,
        "url": url or _resource_url(instance_url, path),
        "display_name": path,
    }


def _gitlab_resource(project: Mapping[str, Any]) -> dict[str, Any]:
    path = _text(project.get("path_with_namespace"))
    url = _text(project.get("web_url"))
    if not path:
        return {}
    instance_url = _instance_from_url(url) or "https://gitlab.com"
    return {
        "resource_type": "project",
        "instance_url": instance_url,
        "external_id": _text(project.get("id")) or path,
        "path": path,
        "url": url or _resource_url(instance_url, path),
        "display_name": path,
    }


def _github_change_request(
    resource: Mapping[str, Any],
    value: Mapping[str, Any],
) -> dict[str, Any]:
    number = value.get("number")
    if number is None:
        return {}
    head = _mapping(value.get("head"))
    base = _mapping(value.get("base"))
    return {
        "type": "change_request",
        "id": f"{resource.get('external_id')}#{number}",
        "provider": "github",
        "instance_url": resource.get("instance_url"),
        "repository": resource.get("path"),
        "number": int(number),
        "url": _text(value.get("html_url")) or None,
        "head_branch": _text(head.get("ref")) or _text(value.get("head_ref")) or None,
        "base_branch": _text(base.get("ref")) or _text(value.get("base_ref")) or None,
        "head_commit": _text(head.get("sha")) or _text(value.get("head_sha")) or None,
    }


def _gitlab_change_request(
    resource: Mapping[str, Any],
    value: Mapping[str, Any],
) -> dict[str, Any]:
    number = value.get("iid")
    if number is None:
        return {}
    return {
        "type": "change_request",
        "id": f"{resource.get('external_id')}#{number}",
        "provider": "gitlab",
        "instance_url": resource.get("instance_url"),
        "repository": resource.get("path"),
        "number": int(number),
        "url": _text(value.get("url")) or None,
        "head_branch": _text(value.get("source_branch")) or None,
        "base_branch": _text(value.get("target_branch")) or None,
        "head_commit": (
            _text(_mapping(value.get("last_commit")).get("id"))
            or _text(value.get("last_commit_sha"))
            or None
        ),
    }


def _change_request_event(
    event_type: str,
    source_type: str,
    resource: dict[str, Any],
    subject: dict[str, Any],
    payload: dict[str, Any],
) -> list[NormalizedProjectEvent]:
    if not subject:
        return []
    return [
        NormalizedProjectEvent(
            event_type=event_type,
            source_type=source_type,
            resource=resource,
            subject=subject,
            payload=payload,
        )
    ]


def _github_user(value: object) -> dict[str, Any] | None:
    user = _mapping(value)
    login = _text(user.get("login"))
    if not login:
        return None
    return {"id": user.get("id"), "login": login}


def _gitlab_author(value: object) -> dict[str, Any] | None:
    user = _mapping(value)
    username = _text(user.get("username"))
    if not username:
        return None
    return {
        "id": user.get("id"),
        "username": username,
        "name": _text(user.get("name")) or None,
    }


def _mapping(value: object) -> Mapping[str, Any]:
    return value if isinstance(value, dict) else {}


def _text(value: object) -> str:
    return value.strip() if isinstance(value, str) else ""


def _normalized_path(value: object) -> str:
    path = _text(value).strip("/")
    return path[:-4] if path.endswith(".git") else path


def _repository_path(value: str) -> str:
    if len([part for part in value.split("/") if part]) < 2:
        raise ValueError("Repository resource requires an owner and repository path")
    return value


def _normalized_instance_url(value: object) -> str:
    text = _text(value).rstrip("/")
    if not text:
        return ""
    parsed = urlparse(text)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("Event source instance URL must use HTTP or HTTPS")
    return f"{parsed.scheme.lower()}://{parsed.netloc.lower()}"


def _instance_from_url(value: str) -> str:
    if not value:
        return ""
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return ""
    return f"{parsed.scheme.lower()}://{parsed.netloc.lower()}"


def _resource_url(instance_url: str, path: str) -> str | None:
    if not instance_url or not path:
        return None
    return f"{instance_url.rstrip('/')}/{path.lstrip('/')}"
