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
            relevant_numbers = {
                int(pull["number"])
                for pull in relevant
                if isinstance(pull.get("number"), int)
            }
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
            if int(state.get("page") or 1) == 1:
                changes.extend(
                    await self._open_pull_health_sweep_inputs(
                        client,
                        api_base=api_base,
                        repository=repository,
                        headers=headers,
                        seen_numbers=relevant_numbers,
                    )
                )
                changes.extend(
                    await self._merged_pull_sweep_inputs(
                        client,
                        api_base=api_base,
                        repository=repository,
                        headers=headers,
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
        conflict = _pull_request_conflict_input(
            number=number,
            pull=detail,
            repository_payload=repository_payload,
        )
        if conflict is not None:
            changes.append(conflict)
        if head_sha:
            checks = await self._list_all(
                client,
                f"{api_base}/repos/{repository}/commits/{head_sha}/check-runs",
                headers=headers,
                params={"filter": "latest"},
                list_key="check_runs",
            )
            changes.extend(
                _failed_check_run_inputs(
                    number=number,
                    head_sha=head_sha,
                    checks=checks,
                    pull_requests=[detail],
                    repository_payload=repository_payload,
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

    async def _open_pull_health_sweep_inputs(
        self,
        client: httpx.AsyncClient,
        *,
        api_base: str,
        repository: str,
        headers: Mapping[str, str],
        seen_numbers: set[int],
    ) -> list[PolledInput]:
        """Sweep every open PR for conflicts and failed checks.

        Mergeability and CI results can change without touching the PR's
        ``updated_at`` (for example when the target branch moves), which would
        keep the PR out of the incremental window forever.
        """

        changes: list[PolledInput] = []
        page = 1
        while page <= 50:
            pulls = await self._get(
                client,
                f"{api_base}/repos/{repository}/pulls",
                headers=headers,
                params={
                    "state": "open",
                    "sort": "updated",
                    "direction": "desc",
                    "per_page": POLL_PAGE_SIZE,
                    "page": page,
                },
            )
            if not isinstance(pulls, list):
                raise EventPollingError("GitHub pull request response is invalid")
            for pull in pulls:
                if not isinstance(pull, dict):
                    continue
                try:
                    number = int(pull["number"])
                except (KeyError, TypeError, ValueError):
                    continue
                if number in seen_numbers:
                    continue
                detail = await self._get(
                    client,
                    f"{api_base}/repos/{repository}/pulls/{number}",
                    headers=headers,
                )
                if not isinstance(detail, dict):
                    continue
                repository_payload = _github_repository_payload(repository, detail)
                conflict = _pull_request_conflict_input(
                    number=number,
                    pull=detail,
                    repository_payload=repository_payload,
                )
                if conflict is not None:
                    changes.append(conflict)
                head_sha = _text(_mapping(detail.get("head")).get("sha"))
                if head_sha:
                    checks = await self._list_all(
                        client,
                        f"{api_base}/repos/{repository}/commits/{head_sha}/check-runs",
                        headers=headers,
                        params={"filter": "latest"},
                        list_key="check_runs",
                    )
                    changes.extend(
                        _failed_check_run_inputs(
                            number=number,
                            head_sha=head_sha,
                            checks=checks,
                            pull_requests=[detail],
                            repository_payload=repository_payload,
                        )
                    )
            if len(pulls) < POLL_PAGE_SIZE:
                break
            page += 1
        return changes

    async def _merged_pull_sweep_inputs(
        self,
        client: httpx.AsyncClient,
        *,
        api_base: str,
        repository: str,
        headers: Mapping[str, str],
    ) -> list[PolledInput]:
        """Emit merged events for recently closed merged PRs.

        A merged PR leaves the ``open`` list, so polling would never see it.
        Sweep the most recent closed PRs once per cycle; ingestion deduplicates
        by ``pull_request:{number}:merged:{sha}``.
        """

        changes: list[PolledInput] = []
        for page in range(1, 4):
            pulls = await self._get(
                client,
                f"{api_base}/repos/{repository}/pulls",
                headers=headers,
                params={
                    "state": "closed",
                    "sort": "updated",
                    "direction": "desc",
                    "per_page": POLL_PAGE_SIZE,
                    "page": page,
                },
            )
            if not isinstance(pulls, list):
                raise EventPollingError("GitHub pull request response is invalid")
            for pull in pulls:
                if not isinstance(pull, dict) or pull.get("merged") is not True:
                    continue
                try:
                    number = int(pull["number"])
                except (KeyError, TypeError, ValueError):
                    continue
                repository_payload = _github_repository_payload(repository, pull)
                changes.append(
                    _pull_request_merged_input(
                        number=number,
                        pull=pull,
                        repository_payload=repository_payload,
                    )
                )
            if len(pulls) < POLL_PAGE_SIZE:
                break
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
            incremental_ids: set[int] = set()
            for merge_request in merge_requests:
                if not isinstance(merge_request, dict):
                    continue
                try:
                    incremental_ids.add(int(merge_request["iid"]))
                except (KeyError, TypeError, ValueError):
                    pass
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
            # Conflicts can appear without touching the MR itself (for example
            # when the target branch moves), which never bumps ``updated_at``
            # and would keep the MR out of the incremental window forever.
            # Sweep every opened MR once per polling cycle for the conflict
            # state; note/pipeline discovery stays incremental.
            if int(state.get("page") or 1) == 1:
                changes.extend(
                    await self._conflict_sweep_inputs(
                        client,
                        api_base=api_base,
                        project=project,
                        project_path=project_path,
                        instance_url=instance_url,
                        headers=headers,
                        seen_iids=incremental_ids,
                        cutoff=cutoff,
                    )
                )
                changes.extend(
                    await self._merged_sweep_inputs(
                        client,
                        api_base=api_base,
                        project=project,
                        project_path=project_path,
                        instance_url=instance_url,
                        headers=headers,
                    )
                )
        complete = len(merge_requests) < POLL_PAGE_SIZE
        return PollPage(
            inputs=tuple(changes),
            next_cursor=_next_cursor(state, complete),
            complete=complete,
        )

    async def _conflict_sweep_inputs(
        self,
        client: httpx.AsyncClient,
        *,
        api_base: str,
        project: str,
        project_path: str,
        instance_url: str,
        headers: Mapping[str, str],
        seen_iids: set[int],
        cutoff: datetime | None,
    ) -> list[PolledInput]:
        """Return conflict and failed-pipeline events for every opened MR.

        Conflicts and pipeline outcomes can change without touching the MR's
        ``updated_at`` (for example when the target branch moves or CI finishes
        late), which would keep the MR out of the incremental window forever.
        """

        changes: list[PolledInput] = []
        page = 1
        while page <= 50:
            merge_requests = await self._get(
                client,
                f"{api_base}/projects/{project}/merge_requests",
                headers=headers,
                params={
                    "state": "opened",
                    "order_by": "updated_at",
                    "sort": "desc",
                    "per_page": POLL_PAGE_SIZE,
                    "page": page,
                },
            )
            if not isinstance(merge_requests, list):
                raise EventPollingError("GitLab merge request response is invalid")
            for merge_request in merge_requests:
                if not isinstance(merge_request, dict):
                    continue
                try:
                    iid = int(merge_request["iid"])
                except (KeyError, TypeError, ValueError):
                    continue
                if iid in seen_iids:
                    continue
                project_payload = {
                    "id": merge_request.get("project_id"),
                    "path_with_namespace": project_path,
                    "web_url": f"{instance_url}/{project_path}",
                }
                if _is_conflicted(merge_request):
                    changes.append(
                        _conflict_polled_input(
                            iid=iid,
                            change_request=merge_request,
                            project_payload=project_payload,
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
                    if _text(pipeline.get("status")).lower() not in {
                        "failed",
                        "canceled",
                    }:
                        continue
                    changes.append(
                        _gitlab_pipeline_input(
                            iid=iid,
                            pipeline=pipeline,
                            merge_request=merge_request,
                            project_payload=project_payload,
                        )
                    )
            if len(merge_requests) < POLL_PAGE_SIZE:
                break
            page += 1
        return changes

    async def _merged_sweep_inputs(
        self,
        client: httpx.AsyncClient,
        *,
        api_base: str,
        project: str,
        project_path: str,
        instance_url: str,
        headers: Mapping[str, str],
    ) -> list[PolledInput]:
        """Return merged events for recently merged MRs.

        Polling can never see an MR flip to ``merged`` through the incremental
        ``opened`` window, so sweep the most recent merged MRs once per cycle.
        Ingestion deduplicates by ``merge_request:{iid}:merged:{sha}``, so a
        merged MR emits an event exactly once.
        """

        merge_requests = await self._get(
            client,
            f"{api_base}/projects/{project}/merge_requests",
            headers=headers,
            params={
                "state": "merged",
                "order_by": "updated_at",
                "sort": "desc",
                "per_page": POLL_PAGE_SIZE,
            },
        )
        if not isinstance(merge_requests, list):
            raise EventPollingError("GitLab merge request response is invalid")
        changes: list[PolledInput] = []
        for merge_request in merge_requests:
            if not isinstance(merge_request, dict):
                continue
            try:
                iid = int(merge_request["iid"])
            except (KeyError, TypeError, ValueError):
                continue
            if _text(merge_request.get("state")).lower() != "merged":
                continue
            project_payload = {
                "id": merge_request.get("project_id"),
                "path_with_namespace": project_path,
                "web_url": f"{instance_url}/{project_path}",
            }
            changes.append(
                _merged_polled_input(
                    iid=iid,
                    change_request=merge_request,
                    project_payload=project_payload,
                )
            )
        return changes

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
        if _is_conflicted(detail):
            changes.append(
                _conflict_polled_input(
                    iid=iid,
                    change_request=detail,
                    project_payload=project_payload,
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
                _gitlab_pipeline_input(
                    iid=iid,
                    pipeline=pipeline,
                    merge_request=detail,
                    project_payload=project_payload,
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


def _pull_request_conflict_input(
    *,
    number: int,
    pull: Mapping[str, Any],
    repository_payload: dict[str, Any],
) -> PolledInput | None:
    head_sha = _text(_mapping(pull.get("head")).get("sha"))
    mergeable_state = _text(pull.get("mergeable_state")).lower()
    if pull.get("mergeable") is not False and mergeable_state not in {
        "dirty",
        "conflicting",
    }:
        return None
    return PolledInput(
        identity=f"pull_request:{number}:conflict:{head_sha}",
        title=f"github: pull_request #{number}",
        payload={
            "action": "synchronize",
            "pull_request": dict(pull),
            "repository": repository_payload,
        },
        headers={"x-github-event": "pull_request"},
        occurred_at=_text(pull.get("updated_at")) or None,
    )


def _failed_check_run_inputs(
    *,
    number: int,
    head_sha: str,
    checks: list[dict[str, Any]],
    pull_requests: list[dict[str, Any]],
    repository_payload: dict[str, Any],
) -> list[PolledInput]:
    changes: list[PolledInput] = []
    for check in checks:
        conclusion = _text(check.get("conclusion")).lower()
        if _text(check.get("status")).lower() == "completed" and conclusion in {
            "failure",
            "timed_out",
            "cancelled",
            "action_required",
        }:
            changes.append(
                PolledInput(
                    identity=f"check_run:{check.get('id')}:{conclusion}:{head_sha}",
                    title=f"github: check_run #{number}",
                    payload={
                        "action": "completed",
                        "check_run": {
                            **check,
                            "pull_requests": pull_requests,
                            "head_sha": head_sha,
                        },
                        "repository": repository_payload,
                    },
                    headers={"x-github-event": "check_run"},
                    occurred_at=_text(check.get("completed_at")) or None,
                )
            )
    return changes


def _pull_request_merged_input(
    *,
    number: int,
    pull: Mapping[str, Any],
    repository_payload: dict[str, Any],
) -> PolledInput:
    merge_sha = _text(pull.get("merge_commit_sha")) or _text(
        _mapping(pull.get("head")).get("sha")
    )
    return PolledInput(
        identity=f"pull_request:{number}:merged:{merge_sha}",
        title=f"github: pull_request #{number}",
        payload={
            "action": "closed",
            "pull_request": dict(pull),
            "repository": repository_payload,
        },
        headers={"x-github-event": "pull_request"},
        occurred_at=_text(pull.get("merged_at"))
        or _text(pull.get("updated_at"))
        or None,
    )


def _gitlab_merge_request_payload(value: Mapping[str, Any]) -> dict[str, Any]:
    return {
        **dict(value),
        "url": value.get("web_url") or value.get("url"),
        "last_commit": {"id": value.get("sha")},
    }


def _is_conflicted(change_request: Mapping[str, Any]) -> bool:
    merge_status = (
        _text(change_request.get("detailed_merge_status"))
        or _text(change_request.get("merge_status"))
    ).lower()
    return change_request.get("has_conflicts") is True or merge_status in {
        "cannot_be_merged",
        "conflict",
        "conflicting",
    }


def _conflict_polled_input(
    *,
    iid: int,
    change_request: Mapping[str, Any],
    project_payload: dict[str, Any],
) -> PolledInput:
    return PolledInput(
        identity=f"merge_request:{iid}:conflict:{_text(change_request.get('sha'))}",
        title=f"gitlab: merge_request !{iid}",
        payload={
            "object_kind": "merge_request",
            "object_attributes": _gitlab_merge_request_payload(change_request),
            "project": project_payload,
        },
        headers={"x-gitlab-event": "Merge Request Hook"},
        occurred_at=_text(change_request.get("updated_at")) or None,
    )


def _merged_polled_input(
    *,
    iid: int,
    change_request: Mapping[str, Any],
    project_payload: dict[str, Any],
) -> PolledInput:
    return PolledInput(
        identity=f"merge_request:{iid}:merged:{_text(change_request.get('sha'))}",
        title=f"gitlab: merge_request !{iid}",
        payload={
            "object_kind": "merge_request",
            "object_attributes": _gitlab_merge_request_payload(change_request),
            "project": project_payload,
        },
        headers={"x-gitlab-event": "Merge Request Hook"},
        occurred_at=_text(change_request.get("merged_at"))
        or _text(change_request.get("updated_at"))
        or None,
    )


def _gitlab_pipeline_input(
    *,
    iid: int,
    pipeline: Mapping[str, Any],
    merge_request: Mapping[str, Any],
    project_payload: dict[str, Any],
) -> PolledInput:
    return PolledInput(
        identity=f"pipeline:{pipeline.get('id')}:{pipeline.get('status')}",
        title=f"gitlab: pipeline !{iid}",
        payload={
            "object_kind": "pipeline",
            "object_attributes": {
                **dict(pipeline),
                "sha": pipeline.get("sha") or merge_request.get("sha"),
                "ref": pipeline.get("ref") or merge_request.get("source_branch"),
            },
            "merge_request": _gitlab_merge_request_payload(merge_request),
            "project": project_payload,
        },
        headers={"x-gitlab-event": "Pipeline Hook"},
        occurred_at=_text(pipeline.get("updated_at") or pipeline.get("created_at"))
        or None,
    )


def _required_text(value: Mapping[str, Any], key: str) -> str:
    result = _text(value.get(key))
    if not result:
        raise EventPollingError(f"Observed resource requires {key}")
    return result


def _mapping(value: object) -> dict[str, Any]:
    return dict(value) if isinstance(value, dict) else {}


def _text(value: object) -> str:
    return value.strip() if isinstance(value, str) else ""
