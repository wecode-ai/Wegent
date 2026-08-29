# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Polling adapters for project event subscriptions."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Mapping, Protocol
from urllib.parse import quote

import httpx

POLL_PAGE_SIZE = 50
POLL_OVERLAP_SECONDS = 120
MAX_NESTED_PAGES = 10


class EventPollingError(RuntimeError):
    """A polling failure with scheduling and credential semantics."""

    def __init__(
        self,
        message: str,
        *,
        retry_after_seconds: int | None = None,
        disable_subscription: bool = False,
    ) -> None:
        super().__init__(message)
        self.retry_after_seconds = retry_after_seconds
        self.disable_subscription = disable_subscription


@dataclass(frozen=True)
class PolledInput:
    identity: str
    title: str
    payload: dict[str, Any]
    headers: dict[str, str]
    occurred_at: str | None = None


@dataclass(frozen=True)
class PollPage:
    inputs: tuple[PolledInput, ...]
    next_cursor: dict[str, Any]
    complete: bool


class EventSourcePoller(Protocol):
    async def fetch_page(
        self,
        *,
        resource: Mapping[str, Any],
        credential: str,
        cursor: Mapping[str, Any] | None,
    ) -> PollPage: ...


def poller_for(source_type: str) -> EventSourcePoller:
    if source_type == "github":
        return GitHubEventPoller()
    if source_type == "gitlab":
        return GitLabEventPoller()
    raise EventPollingError(
        f"{source_type} does not provide a polling adapter",
        disable_subscription=True,
    )


class _HttpPoller:
    async def _get(
        self,
        client: httpx.AsyncClient,
        url: str,
        *,
        headers: Mapping[str, str],
        params: Mapping[str, Any] | None = None,
    ) -> Any:
        try:
            response = await client.get(url, headers=headers, params=params)
        except httpx.HTTPError as exc:
            raise EventPollingError(f"Event source request failed: {exc}") from exc
        if response.status_code in {401, 403}:
            rate_limited = (
                response.status_code == 403
                and response.headers.get("x-ratelimit-remaining") == "0"
            )
            if not rate_limited:
                raise EventPollingError(
                    "Event source credential was rejected",
                    disable_subscription=True,
                )
        if response.status_code == 429 or (
            response.status_code == 403
            and response.headers.get("x-ratelimit-remaining") == "0"
        ):
            raise EventPollingError(
                "Event source rate limit exceeded",
                retry_after_seconds=_retry_after_seconds(response),
            )
        try:
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            raise EventPollingError(
                f"Event source returned HTTP {response.status_code}"
            ) from exc
        try:
            return response.json()
        except ValueError as exc:
            raise EventPollingError("Event source returned invalid JSON") from exc

    async def _list_all(
        self,
        client: httpx.AsyncClient,
        url: str,
        *,
        headers: Mapping[str, str],
        params: Mapping[str, Any] | None = None,
        list_key: str | None = None,
    ) -> list[dict[str, Any]]:
        values: list[dict[str, Any]] = []
        base_params = dict(params or {})
        for page in range(1, MAX_NESTED_PAGES + 1):
            payload = await self._get(
                client,
                url,
                headers=headers,
                params={**base_params, "per_page": 100, "page": page},
            )
            if list_key and isinstance(payload, dict):
                payload = payload.get(list_key)
            if not isinstance(payload, list):
                raise EventPollingError("Event source list response is invalid")
            rows = [dict(item) for item in payload if isinstance(item, dict)]
            values.extend(rows)
            if len(payload) < 100:
                break
        return values


class GitHubEventPoller(_HttpPoller):
    async def fetch_page(
        self,
        *,
        resource: Mapping[str, Any],
        credential: str,
        cursor: Mapping[str, Any] | None,
    ) -> PollPage:
        repository = _required_text(resource, "path")
        instance_url = _required_text(resource, "instance_url").rstrip("/")
        api_base = (
            "https://api.github.com"
            if instance_url == "https://github.com"
            else f"{instance_url}/api/v3"
        )
        state = _poll_state(cursor)
        headers = {
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {credential}",
            "X-GitHub-Api-Version": "2022-11-28",
        }
        async with httpx.AsyncClient(
            timeout=30,
            follow_redirects=False,
        ) as client:
            pulls = await self._get(
                client,
                f"{api_base}/repos/{repository}/pulls",
                headers=headers,
                params={
                    "state": "open",
                    "sort": "updated",
                    "direction": "desc",
                    "per_page": POLL_PAGE_SIZE,
                    "page": state["page"],
                },
            )
            if not isinstance(pulls, list):
                raise EventPollingError("GitHub pull request response is invalid")
            changes: list[PolledInput] = []
            cutoff = _cursor_cutoff(state["watermark"])
            relevant = [
                dict(value)
                for value in pulls
                if isinstance(value, dict)
                and _is_after(value.get("updated_at"), cutoff)
            ]
            for pull in relevant:
                changes.extend(
                    await self._pull_inputs(
                        client,
                        api_base=api_base,
                        repository=repository,
                        headers=headers,
                        pull=pull,
                        cutoff=cutoff,
                    )
                )
        complete = len(pulls) < POLL_PAGE_SIZE or len(relevant) < len(pulls)
        return PollPage(
            inputs=tuple(changes),
            next_cursor=_next_cursor(state, complete),
            complete=complete,
        )

    async def _pull_inputs(
        self,
        client: httpx.AsyncClient,
        *,
        api_base: str,
        repository: str,
        headers: Mapping[str, str],
        pull: dict[str, Any],
        cutoff: datetime | None,
    ) -> list[PolledInput]:
        number = int(pull["number"])
        detail = await self._get(
            client,
            f"{api_base}/repos/{repository}/pulls/{number}",
            headers=headers,
        )
        if not isinstance(detail, dict):
            raise EventPollingError("GitHub pull request detail is invalid")
        repository_payload = _github_repository_payload(repository, detail)
        changes: list[PolledInput] = []
        head = _mapping(detail.get("head"))
        head_sha = _text(head.get("sha"))
        mergeable_state = _text(detail.get("mergeable_state")).lower()
        if detail.get("mergeable") is False or mergeable_state in {
            "dirty",
            "conflicting",
        }:
            changes.append(
                PolledInput(
                    identity=f"pull_request:{number}:conflict:{head_sha}",
                    title=f"github: pull_request #{number}",
                    payload={
                        "action": "synchronize",
                        "pull_request": detail,
                        "repository": repository_payload,
                    },
                    headers={"x-github-event": "pull_request"},
                    occurred_at=_text(detail.get("updated_at")) or None,
                )
            )
        if head_sha:
            checks = await self._list_all(
                client,
                f"{api_base}/repos/{repository}/commits/{head_sha}/check-runs",
                headers=headers,
                params={"filter": "latest"},
                list_key="check_runs",
            )
            for check in checks:
                conclusion = _text(check.get("conclusion")).lower()
                if _text(check.get("status")).lower() == "completed" and conclusion in {
                    "failure",
                    "timed_out",
                    "cancelled",
                    "action_required",
                }:
                    check_payload = {
                        **check,
                        "pull_requests": [detail],
                        "head_sha": head_sha,
                    }
                    changes.append(
                        PolledInput(
                            identity=(
                                f"check_run:{check.get('id')}:{conclusion}:{head_sha}"
                            ),
                            title=f"github: check_run #{number}",
                            payload={
                                "action": "completed",
                                "check_run": check_payload,
                                "repository": repository_payload,
                            },
                            headers={"x-github-event": "check_run"},
                            occurred_at=_text(check.get("completed_at")) or None,
                        )
                    )
        reviews = await self._list_all(
            client,
            f"{api_base}/repos/{repository}/pulls/{number}/reviews",
            headers=headers,
        )
        for review in reviews:
            occurred_at = _text(review.get("submitted_at"))
            if not _is_after(occurred_at, cutoff):
                continue
            changes.append(
                PolledInput(
                    identity=f"pull_request_review:{review.get('id')}",
                    title=f"github: pull_request_review #{number}",
                    payload={
                        "action": "submitted",
                        "review": review,
                        "pull_request": detail,
                        "repository": repository_payload,
                    },
                    headers={"x-github-event": "pull_request_review"},
                    occurred_at=occurred_at or None,
                )
            )
        issue_comments = await self._list_all(
            client,
            f"{api_base}/repos/{repository}/issues/{number}/comments",
            headers=headers,
            params={"since": _isoformat(cutoff)} if cutoff else None,
        )
        for comment in issue_comments:
            changes.append(
                PolledInput(
                    identity=f"issue_comment:{comment.get('id')}",
                    title=f"github: issue_comment #{number}",
                    payload={
                        "action": "created",
                        "comment": comment,
                        "issue": {**detail, "pull_request": {"url": detail.get("url")}},
                        "repository": repository_payload,
                    },
                    headers={"x-github-event": "issue_comment"},
                    occurred_at=_text(comment.get("created_at")) or None,
                )
            )
        review_comments = await self._list_all(
            client,
            f"{api_base}/repos/{repository}/pulls/{number}/comments",
            headers=headers,
            params={"since": _isoformat(cutoff)} if cutoff else None,
        )
        for comment in review_comments:
            changes.append(
                PolledInput(
                    identity=f"pull_request_review_comment:{comment.get('id')}",
                    title=f"github: pull_request_review_comment #{number}",
                    payload={
                        "action": "created",
                        "comment": comment,
                        "pull_request": detail,
                        "repository": repository_payload,
                    },
                    headers={"x-github-event": "pull_request_review_comment"},
                    occurred_at=_text(comment.get("created_at")) or None,
                )
            )
        return changes


class GitLabEventPoller(_HttpPoller):
    async def fetch_page(
        self,
        *,
        resource: Mapping[str, Any],
        credential: str,
        cursor: Mapping[str, Any] | None,
    ) -> PollPage:
        project_path = _required_text(resource, "path")
        instance_url = _required_text(resource, "instance_url").rstrip("/")
        project = quote(project_path, safe="")
        api_base = f"{instance_url}/api/v4"
        state = _poll_state(cursor)
        cutoff = _cursor_cutoff(state["watermark"])
        params: dict[str, Any] = {
            "state": "opened",
            "order_by": "updated_at",
            "sort": "desc",
            "per_page": POLL_PAGE_SIZE,
            "page": state["page"],
        }
        if cutoff:
            params["updated_after"] = _isoformat(cutoff)
        headers = {"PRIVATE-TOKEN": credential}
        async with httpx.AsyncClient(
            timeout=30,
            follow_redirects=False,
        ) as client:
            merge_requests = await self._get(
                client,
                f"{api_base}/projects/{project}/merge_requests",
                headers=headers,
                params=params,
            )
            if not isinstance(merge_requests, list):
                raise EventPollingError("GitLab merge request response is invalid")
            changes: list[PolledInput] = []
            for merge_request in merge_requests:
                if not isinstance(merge_request, dict):
                    continue
                changes.extend(
                    await self._merge_request_inputs(
                        client,
                        api_base=api_base,
                        project=project,
                        project_path=project_path,
                        instance_url=instance_url,
                        headers=headers,
                        merge_request=dict(merge_request),
                        cutoff=cutoff,
                    )
                )
        complete = len(merge_requests) < POLL_PAGE_SIZE
        return PollPage(
            inputs=tuple(changes),
            next_cursor=_next_cursor(state, complete),
            complete=complete,
        )

    async def _merge_request_inputs(
        self,
        client: httpx.AsyncClient,
        *,
        api_base: str,
        project: str,
        project_path: str,
        instance_url: str,
        headers: Mapping[str, str],
        merge_request: dict[str, Any],
        cutoff: datetime | None,
    ) -> list[PolledInput]:
        iid = int(merge_request["iid"])
        detail = await self._get(
            client,
            f"{api_base}/projects/{project}/merge_requests/{iid}",
            headers=headers,
        )
        if not isinstance(detail, dict):
            raise EventPollingError("GitLab merge request detail is invalid")
        project_payload = {
            "id": detail.get("project_id"),
            "path_with_namespace": project_path,
            "web_url": f"{instance_url}/{project_path}",
        }
        changes: list[PolledInput] = []
        head_sha = _text(detail.get("sha"))
        merge_status = (
            _text(detail.get("detailed_merge_status"))
            or _text(detail.get("merge_status"))
        ).lower()
        if detail.get("has_conflicts") is True or merge_status in {
            "cannot_be_merged",
            "conflict",
            "conflicting",
        }:
            attributes = _gitlab_merge_request_payload(detail)
            changes.append(
                PolledInput(
                    identity=f"merge_request:{iid}:conflict:{head_sha}",
                    title=f"gitlab: merge_request !{iid}",
                    payload={
                        "object_kind": "merge_request",
                        "object_attributes": attributes,
                        "project": project_payload,
                    },
                    headers={"x-gitlab-event": "Merge Request Hook"},
                    occurred_at=_text(detail.get("updated_at")) or None,
                )
            )
        pipelines = await self._list_all(
            client,
            f"{api_base}/projects/{project}/merge_requests/{iid}/pipelines",
            headers=headers,
        )
        for pipeline in pipelines:
            occurred_at = _text(
                pipeline.get("updated_at") or pipeline.get("created_at")
            )
            if not _is_after(occurred_at, cutoff):
                continue
            if _text(pipeline.get("status")).lower() not in {"failed", "canceled"}:
                continue
            changes.append(
                PolledInput(
                    identity=(
                        f"pipeline:{pipeline.get('id')}:{pipeline.get('status')}"
                    ),
                    title=f"gitlab: pipeline !{iid}",
                    payload={
                        "object_kind": "pipeline",
                        "object_attributes": {
                            **pipeline,
                            "sha": pipeline.get("sha") or head_sha,
                            "ref": pipeline.get("ref") or detail.get("source_branch"),
                        },
                        "merge_request": _gitlab_merge_request_payload(detail),
                        "project": project_payload,
                    },
                    headers={"x-gitlab-event": "Pipeline Hook"},
                    occurred_at=occurred_at or None,
                )
            )
        notes = await self._list_all(
            client,
            f"{api_base}/projects/{project}/merge_requests/{iid}/notes",
            headers=headers,
            params={"sort": "asc", "order_by": "updated_at"},
        )
        for note in notes:
            occurred_at = _text(note.get("created_at"))
            if not _is_after(occurred_at, cutoff) or note.get("system") is True:
                continue
            changes.append(
                PolledInput(
                    identity=f"note:{note.get('id')}",
                    title=f"gitlab: note !{iid}",
                    payload={
                        "object_kind": "note",
                        "object_attributes": note,
                        "merge_request": _gitlab_merge_request_payload(detail),
                        "project": project_payload,
                    },
                    headers={"x-gitlab-event": "Note Hook"},
                    occurred_at=occurred_at or None,
                )
            )
        approvals = await self._get(
            client,
            f"{api_base}/projects/{project}/merge_requests/{iid}/approvals",
            headers=headers,
        )
        if isinstance(approvals, dict):
            approved_by = approvals.get("approved_by")
            for approval in approved_by if isinstance(approved_by, list) else []:
                user = _mapping(_mapping(approval).get("user"))
                user_id = user.get("id")
                if user_id is None:
                    continue
                changes.append(
                    PolledInput(
                        identity=f"approval:{iid}:{user_id}:{head_sha}",
                        title=f"gitlab: approval !{iid}",
                        payload={
                            "object_kind": "approval",
                            "object_attributes": _gitlab_merge_request_payload(detail),
                            "project": project_payload,
                            "user": dict(user),
                        },
                        headers={"x-gitlab-event": "Approval Hook"},
                        occurred_at=_text(detail.get("updated_at")) or None,
                    )
                )
        return changes


def _poll_state(cursor: Mapping[str, Any] | None) -> dict[str, Any]:
    current = dict(cursor or {})
    scan_started_at = _text(current.get("scan_started_at")) or _isoformat(
        datetime.now(timezone.utc)
    )
    return {
        "watermark": _text(current.get("watermark")) or None,
        "scan_started_at": scan_started_at,
        "page": max(int(current.get("page") or 1), 1),
    }


def _next_cursor(state: Mapping[str, Any], complete: bool) -> dict[str, Any]:
    if complete:
        return {
            "watermark": state["scan_started_at"],
            "page": 1,
        }
    return {
        "watermark": state.get("watermark"),
        "scan_started_at": state["scan_started_at"],
        "page": int(state["page"]) + 1,
    }


def _cursor_cutoff(watermark: object) -> datetime | None:
    parsed = _parse_datetime(watermark)
    return parsed - timedelta(seconds=POLL_OVERLAP_SECONDS) if parsed else None


def _parse_datetime(value: object) -> datetime | None:
    text = _text(value)
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _is_after(value: object, cutoff: datetime | None) -> bool:
    if cutoff is None:
        return True
    parsed = _parse_datetime(value)
    return parsed is not None and parsed > cutoff


def _isoformat(value: datetime | None) -> str:
    if value is None:
        return ""
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _retry_after_seconds(response: httpx.Response) -> int:
    value = response.headers.get("retry-after")
    if value and value.isdigit():
        return min(max(int(value), 1), 86_400)
    reset = response.headers.get("x-ratelimit-reset")
    if reset and reset.isdigit():
        seconds = int(reset) - int(datetime.now(timezone.utc).timestamp())
        return min(max(seconds, 1), 86_400)
    return 300


def _github_repository_payload(
    repository: str,
    pull: Mapping[str, Any],
) -> dict[str, Any]:
    base_repo = _mapping(_mapping(pull.get("base")).get("repo"))
    return {
        "id": base_repo.get("id"),
        "full_name": _text(base_repo.get("full_name")) or repository,
        "html_url": _text(base_repo.get("html_url")),
    }


def _gitlab_merge_request_payload(value: Mapping[str, Any]) -> dict[str, Any]:
    return {
        **dict(value),
        "url": value.get("web_url") or value.get("url"),
        "last_commit": {"id": value.get("sha")},
    }


def _required_text(value: Mapping[str, Any], key: str) -> str:
    result = _text(value.get(key))
    if not result:
        raise EventPollingError(f"Observed resource requires {key}")
    return result


def _mapping(value: object) -> dict[str, Any]:
    return dict(value) if isinstance(value, dict) else {}


def _text(value: object) -> str:
    return value.strip() if isinstance(value, str) else ""
