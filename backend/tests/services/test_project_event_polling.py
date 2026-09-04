# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Tests for durable project event-source polling."""

from datetime import datetime, timedelta

import httpx
import pytest

from app.models.delivery import CloudProject, ProjectIncomingEvent, ProjectIncomingHook
from app.services.connector_connections import connector_connection_service
from app.services.project_event_polling import (
    EventPollingError,
    GitHubEventPoller,
    GitLabEventPoller,
    PolledInput,
    PollPage,
)
from app.services.project_event_polling_service import (
    project_event_polling_service,
)


def _project(test_db, test_user) -> CloudProject:
    project = CloudProject(
        project_key="POLL",
        name="Polling project",
        status="active",
        created_by_user_id=test_user.id,
        storage_prefix="projects/polling",
    )
    test_db.add(project)
    test_db.flush()
    return project


def _subscription(test_db, test_user, project: CloudProject) -> ProjectIncomingHook:
    hook = ProjectIncomingHook(
        public_id="polling-subscription",
        cloud_project_id=str(project.id),
        name="GitHub polling",
        source="github",
        status="active",
        due_at=datetime(2020, 1, 1),
        created_by_user_id=test_user.id,
        metadata_json={
            "schema_version": 1,
            "source_type": "github",
            "collection_mode": "poll",
            "credential_ref": "github",
            "resource": {
                "resource_type": "repository",
                "instance_url": "https://github.com",
                "external_id": "acme/app",
                "path": "acme/app",
                "url": "https://github.com/acme/app",
                "display_name": "acme/app",
            },
            "poll": {
                "interval_seconds": 300,
                "cursor": None,
                "failure_count": 0,
            },
            "health": {"status": "pending"},
        },
    )
    test_db.add(hook)
    test_db.commit()
    return hook


def _connect_github(test_db, test_user) -> None:
    connector_connection_service.save_oauth_connection(
        test_db,
        slug="github",
        user_id=test_user.id,
        access_token="github-token",
        refresh_token=None,
        token_type="bearer",
        granted_scopes=["repo"],
        external_account_name="octocat",
        expires_at=None,
    )


@pytest.mark.asyncio
async def test_due_poll_persists_each_page_and_advances_cursor(
    test_db,
    test_user,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project = _project(test_db, test_user)
    hook = _subscription(test_db, test_user, project)
    _connect_github(test_db, test_user)
    calls: list[dict | None] = []

    class FakePoller:
        async def fetch_page(self, *, resource, credential, cursor):
            assert resource["path"] == "acme/app"
            assert credential == "github-token"
            calls.append(dict(cursor) if cursor else None)
            page = len(calls)
            return PollPage(
                inputs=(
                    PolledInput(
                        identity=f"check_run:{page}",
                        title=f"github: check_run {page}",
                        payload={
                            "action": "completed",
                            "check_run": {
                                "id": page,
                                "status": "completed",
                                "conclusion": "failure",
                                "head_sha": "abc1234",
                                "pull_requests": [],
                            },
                            "repository": {
                                "id": 42,
                                "full_name": "acme/app",
                                "html_url": "https://github.com/acme/app",
                            },
                        },
                        headers={"x-github-event": "check_run"},
                    ),
                ),
                next_cursor=(
                    {
                        "watermark": None,
                        "scan_started_at": "2026-08-27T00:00:00Z",
                        "page": 2,
                    }
                    if page == 1
                    else {
                        "watermark": "2026-08-27T00:00:00Z",
                        "page": 1,
                    }
                ),
                complete=page == 2,
            )

    monkeypatch.setattr(
        "app.services.project_event_polling_service.poller_for",
        lambda _source_type: FakePoller(),
    )

    discovered = await project_event_polling_service.check_due(test_db)

    assert discovered == 2
    assert calls == [
        None,
        {
            "watermark": None,
            "scan_started_at": "2026-08-27T00:00:00Z",
            "page": 2,
        },
    ]
    events = (
        test_db.query(ProjectIncomingEvent)
        .filter(ProjectIncomingEvent.parent_id == hook.id)
        .order_by(ProjectIncomingEvent.title)
        .all()
    )
    assert len(events) == 2
    assert all(event.status == "received" for event in events)
    test_db.refresh(hook)
    assert hook.metadata_json["poll"]["cursor"] == {
        "watermark": "2026-08-27T00:00:00Z",
        "page": 1,
    }
    assert hook.metadata_json["health"]["status"] == "healthy"
    assert hook.due_at > datetime.utcnow() + timedelta(seconds=240)


@pytest.mark.asyncio
async def test_polling_failure_keeps_cursor_and_uses_retry_backoff(
    test_db,
    test_user,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project = _project(test_db, test_user)
    hook = _subscription(test_db, test_user, project)
    _connect_github(test_db, test_user)

    class FailingPoller:
        async def fetch_page(self, **_kwargs):
            raise EventPollingError(
                "Event source rate limit exceeded",
                retry_after_seconds=600,
            )

    monkeypatch.setattr(
        "app.services.project_event_polling_service.poller_for",
        lambda _source_type: FailingPoller(),
    )
    before = datetime.utcnow()

    assert await project_event_polling_service.check_due(test_db) == 0

    test_db.refresh(hook)
    assert hook.status == "active"
    assert hook.metadata_json["poll"]["cursor"] is None
    assert hook.metadata_json["poll"]["failure_count"] == 1
    assert hook.metadata_json["health"]["status"] == "error"
    assert hook.due_at >= before + timedelta(seconds=590)


@pytest.mark.asyncio
async def test_github_poller_emits_webhook_equivalent_inputs(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path.endswith("/pulls"):
            return httpx.Response(
                200,
                json=[
                    {
                        "number": 7,
                        "updated_at": "2026-08-27T00:05:00Z",
                    }
                ],
            )
        if path.endswith("/pulls/7"):
            return httpx.Response(
                200,
                json={
                    "number": 7,
                    "html_url": "https://github.com/acme/app/pull/7",
                    "updated_at": "2026-08-27T00:05:00Z",
                    "mergeable": False,
                    "mergeable_state": "dirty",
                    "head": {"ref": "fix/checks", "sha": "abc1234"},
                    "base": {
                        "ref": "main",
                        "repo": {
                            "id": 42,
                            "full_name": "acme/app",
                            "html_url": "https://github.com/acme/app",
                        },
                    },
                },
            )
        if path.endswith("/check-runs"):
            return httpx.Response(
                200,
                json={
                    "check_runs": [
                        {
                            "id": 100,
                            "status": "completed",
                            "conclusion": "failure",
                            "completed_at": "2026-08-27T00:04:00Z",
                        }
                    ]
                },
            )
        if path.endswith("/reviews"):
            return httpx.Response(
                200,
                json=[
                    {
                        "id": 200,
                        "submitted_at": "2026-08-27T00:03:00Z",
                    }
                ],
            )
        if path.endswith("/issues/7/comments"):
            return httpx.Response(
                200,
                json=[{"id": 300, "created_at": "2026-08-27T00:02:00Z"}],
            )
        if path.endswith("/pulls/7/comments"):
            return httpx.Response(
                200,
                json=[{"id": 400, "created_at": "2026-08-27T00:01:00Z"}],
            )
        raise AssertionError(f"Unexpected request: {request.url}")

    transport = httpx.MockTransport(handler)
    original_client = httpx.AsyncClient

    def client_factory(*args, **kwargs):
        return original_client(*args, transport=transport, **kwargs)

    monkeypatch.setattr(
        "app.services.project_event_polling.httpx.AsyncClient",
        client_factory,
    )

    page = await GitHubEventPoller().fetch_page(
        resource={
            "path": "acme/app",
            "instance_url": "https://github.com",
        },
        credential="github-token",
        cursor={"watermark": "2026-08-26T23:59:00Z", "page": 1},
    )

    assert page.complete
    assert {value.headers["x-github-event"] for value in page.inputs} == {
        "pull_request",
        "check_run",
        "pull_request_review",
        "issue_comment",
        "pull_request_review_comment",
    }


@pytest.mark.anyio
async def test_gitlab_poller_detects_conflict_outside_incremental_window(monkeypatch):
    """Target-branch conflicts must be found even when the MR was not updated."""

    def handler(request):
        if request.url.path.endswith("/pipelines"):
            return httpx.Response(200, json=[])
        if not request.url.path.endswith("/merge_requests"):
            raise AssertionError(f"Unexpected request: {request.url}")
        params = dict(request.url.params)
        if "updated_after" in params:
            return httpx.Response(200, json=[])
        if params.get("state") == "merged":
            return httpx.Response(200, json=[])
        return httpx.Response(
            200,
            json=[
                {
                    "iid": 41,
                    "project_id": 1,
                    "title": "Conflict MR",
                    "web_url": "https://gitlab.example/g/p/-/merge_requests/41",
                    "source_branch": "feature",
                    "target_branch": "main",
                    "sha": "conflict-sha-1",
                    "has_conflicts": True,
                    "detailed_merge_status": "conflict",
                    "updated_at": "2026-09-03T10:19:04.000Z",
                }
            ],
        )

    transport = httpx.MockTransport(handler)
    original_client = httpx.AsyncClient

    def client_factory(*args, **kwargs):
        return original_client(*args, transport=transport, **kwargs)

    monkeypatch.setattr(
        "app.services.project_event_polling.httpx.AsyncClient",
        client_factory,
    )

    page = await GitLabEventPoller().fetch_page(
        resource={
            "path": "g/p",
            "instance_url": "https://gitlab.example",
        },
        credential="gitlab-token",
        cursor={"watermark": "2026-09-03T10:00:00Z", "page": 1},
    )

    assert page.complete
    conflicts = [
        value
        for value in page.inputs
        if value.identity == "merge_request:41:conflict:conflict-sha-1"
    ]
    assert len(conflicts) == 1
    assert (
        conflicts[0].payload["object_attributes"]["url"].endswith("/merge_requests/41")
    )


@pytest.mark.anyio
async def test_gitlab_poller_emits_merged_event_for_merged_mr(monkeypatch):
    """A merged MR must release the loop end even when only polled."""

    def handler(request):
        if request.url.path.endswith("/pipelines"):
            return httpx.Response(200, json=[])
        if not request.url.path.endswith("/merge_requests"):
            raise AssertionError(f"Unexpected request: {request.url}")
        params = dict(request.url.params)
        if "updated_after" in params or params.get("state") != "merged":
            return httpx.Response(200, json=[])
        return httpx.Response(
            200,
            json=[
                {
                    "iid": 41,
                    "project_id": 1,
                    "title": "Merged MR",
                    "web_url": "https://gitlab.example/g/p/-/merge_requests/41",
                    "source_branch": "feature",
                    "target_branch": "main",
                    "state": "merged",
                    "sha": "merged-sha-1",
                    "merged_at": "2026-09-03T10:27:06.284Z",
                    "updated_at": "2026-09-03T10:27:06.758Z",
                }
            ],
        )

    transport = httpx.MockTransport(handler)
    original_client = httpx.AsyncClient

    def client_factory(*args, **kwargs):
        return original_client(*args, transport=transport, **kwargs)

    monkeypatch.setattr(
        "app.services.project_event_polling.httpx.AsyncClient",
        client_factory,
    )

    page = await GitLabEventPoller().fetch_page(
        resource={
            "path": "g/p",
            "instance_url": "https://gitlab.example",
        },
        credential="gitlab-token",
        cursor={"watermark": "2026-09-03T10:00:00Z", "page": 1},
    )

    merged = [
        value
        for value in page.inputs
        if value.identity == "merge_request:41:merged:merged-sha-1"
    ]
    assert len(merged) == 1
    assert merged[0].occurred_at == "2026-09-03T10:27:06.284Z"


@pytest.mark.anyio
async def test_github_poller_emits_merged_event_from_closed_sweep(monkeypatch):
    """A merged PR must release the loop end even when only polled."""

    def handler(request):
        if request.url.path.endswith("/pulls"):
            params = dict(request.url.params)
            if params.get("state") != "closed":
                return httpx.Response(200, json=[])
            return httpx.Response(
                200,
                json=[
                    {
                        "number": 9,
                        "state": "closed",
                        "merged": True,
                        "merged_at": "2026-09-03T10:30:00Z",
                        "updated_at": "2026-09-03T10:31:00Z",
                        "merge_commit_sha": "merge-sha-9",
                        "head": {"sha": "head-sha-9"},
                        "base": {
                            "repo": {
                                "id": 1,
                                "full_name": "acme/app",
                                "html_url": "https://github.com/acme/app",
                            }
                        },
                    }
                ],
            )
        raise AssertionError(f"Unexpected request: {request.url}")

    transport = httpx.MockTransport(handler)
    original_client = httpx.AsyncClient

    def client_factory(*args, **kwargs):
        return original_client(*args, transport=transport, **kwargs)

    monkeypatch.setattr(
        "app.services.project_event_polling.httpx.AsyncClient",
        client_factory,
    )

    page = await GitHubEventPoller().fetch_page(
        resource={
            "path": "acme/app",
            "instance_url": "https://github.com",
        },
        credential="github-token",
        cursor={"watermark": "2026-09-03T10:00:00Z", "page": 1},
    )

    merged = [
        value
        for value in page.inputs
        if value.identity == "pull_request:9:merged:merge-sha-9"
    ]
    assert len(merged) == 1


@pytest.mark.anyio
async def test_github_poller_health_sweep_finds_conflict_and_failed_checks(
    monkeypatch,
):
    """Open PRs outside the incremental window still get conflict/CI checks."""

    def handler(request):
        path = request.url.path
        if (
            path.endswith("/pulls")
            and dict(request.url.params).get("state") == "closed"
        ):
            return httpx.Response(200, json=[])
        if path.endswith("/pulls"):
            return httpx.Response(
                200,
                json=[
                    {
                        "number": 9,
                        "updated_at": "2026-09-03T09:00:00Z",
                    }
                ],
            )
        if path.endswith("/pulls/9"):
            return httpx.Response(
                200,
                json={
                    "number": 9,
                    "url": "https://github.com/acme/app/pulls/9",
                    "updated_at": "2026-09-03T09:00:00Z",
                    "mergeable": False,
                    "mergeable_state": "dirty",
                    "head": {"sha": "head-sha-9"},
                    "base": {
                        "repo": {
                            "id": 1,
                            "full_name": "acme/app",
                            "html_url": "https://github.com/acme/app",
                        }
                    },
                },
            )
        if path.endswith("/commits/head-sha-9/check-runs"):
            return httpx.Response(
                200,
                json={
                    "check_runs": [
                        {
                            "id": 500,
                            "status": "completed",
                            "conclusion": "failure",
                            "completed_at": "2026-09-03T09:10:00Z",
                            "name": "ci",
                        }
                    ]
                },
            )
        raise AssertionError(f"Unexpected request: {request.url}")

    transport = httpx.MockTransport(handler)
    original_client = httpx.AsyncClient

    def client_factory(*args, **kwargs):
        return original_client(*args, transport=transport, **kwargs)

    monkeypatch.setattr(
        "app.services.project_event_polling.httpx.AsyncClient",
        client_factory,
    )

    page = await GitHubEventPoller().fetch_page(
        resource={
            "path": "acme/app",
            "instance_url": "https://github.com",
        },
        credential="github-token",
        cursor={"watermark": "2026-09-03T10:00:00Z", "page": 1},
    )

    identities = {value.identity for value in page.inputs}
    assert "pull_request:9:conflict:head-sha-9" in identities
    assert "check_run:500:failure:head-sha-9" in identities
