# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the bounded GitLab REST client."""

import json
import math
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.wiki.connector import WikiApiError, WikiSiteConfig
from app.services.wiki.connectors.gitlab_client import GitLabExternalWikiClient


class _ResponseContent:
    def __init__(self, payload: object) -> None:
        self.body = json.dumps(payload).encode()

    async def iter_chunked(self, _size: int):
        yield self.body


def _response(status: int, payload: object, headers: dict | None = None) -> MagicMock:
    response = MagicMock()
    response.status = status
    response.headers = headers or {}
    response.content = _ResponseContent(payload)
    response.__aenter__ = AsyncMock(return_value=response)
    response.__aexit__ = AsyncMock(return_value=None)
    return response


def _manager(response: MagicMock) -> tuple[MagicMock, MagicMock]:
    session = MagicMock()
    session.request.return_value = response
    manager = MagicMock()
    manager.__aenter__ = AsyncMock(return_value=session)
    manager.__aexit__ = AsyncMock(return_value=None)
    return manager, session


@pytest.mark.asyncio
async def test_list_projects_omits_empty_search_parameter() -> None:
    client = GitLabExternalWikiClient(
        WikiSiteConfig(site_url="http://gitlab.internal", api_key="test-token")
    )
    manager, session = _manager(_response(200, []))

    with patch(
        "app.services.wiki.connectors.gitlab_client.AsyncSessionManager",
        return_value=manager,
    ):
        await client.list_projects(limit=1)

    assert session.request.call_args.kwargs["params"] == {
        "membership": "true",
        "simple": "true",
        "order_by": "last_activity_at",
        "sort": "desc",
        "per_page": 1,
        "page": 1,
    }


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("method_name", "args", "kwargs"),
    [
        ("list_projects", (), {}),
        ("list_branches", ("group/project",), {}),
        (
            "list_repository_tree",
            ("group/project",),
            {"ref": "main"},
        ),
    ],
)
async def test_gitlab_pagination_clamps_page_size(
    method_name: str,
    args: tuple,
    kwargs: dict,
) -> None:
    client = GitLabExternalWikiClient(
        WikiSiteConfig(site_url="http://gitlab.internal", api_key="test-token")
    )
    client._request = AsyncMock(
        side_effect=[
            ([{"id": index} for index in range(100)], {"X-Next-Page": "2"}),
            ([], {}),
        ]
    )
    method = getattr(client, method_name)

    first_page = await method(*args, **kwargs, limit=200, offset=0)
    await method(*args, **kwargs, limit=200, offset=first_page.next_offset)

    first_params = client._request.await_args_list[0].kwargs["params"]
    second_params = client._request.await_args_list[1].kwargs["params"]
    assert first_params["per_page"] == 100
    assert first_page.next_offset == 100
    assert second_params["per_page"] == 100
    assert second_params["page"] == 2


@pytest.mark.asyncio
async def test_http_self_hosted_url_auth_and_paths_are_preserved() -> None:
    client = GitLabExternalWikiClient(
        WikiSiteConfig(
            site_url="http://gitlab.internal/root/",
            api_key="test-token",
        )
    )
    manager, session = _manager(
        _response(
            200,
            {"file_name": "run book.md", "content": "", "encoding": "base64"},
        )
    )

    with patch(
        "app.services.wiki.connectors.gitlab_client.AsyncSessionManager",
        return_value=manager,
    ):
        await client.get_repository_file(
            "group/sub project",
            path="docs/run book.md",
            ref="feature/docs",
        )

    request = session.request.call_args
    assert request.args == (
        "GET",
        "http://gitlab.internal/root/api/v4/projects/"
        "group%2Fsub%20project/repository/files/docs%2Frun%20book.md",
    )
    assert request.kwargs["params"] == {"ref": "feature/docs"}
    assert request.kwargs["headers"] == {"PRIVATE-TOKEN": "test-token"}
    assert request.kwargs["allow_redirects"] is False


@pytest.mark.asyncio
async def test_redirect_is_rejected_without_following_it() -> None:
    client = GitLabExternalWikiClient(
        WikiSiteConfig(site_url="https://gitlab.example.com", api_key="test-token")
    )
    manager, _ = _manager(_response(302, None, {"Location": "https://other.test"}))

    with patch(
        "app.services.wiki.connectors.gitlab_client.AsyncSessionManager",
        return_value=manager,
    ):
        with pytest.raises(WikiApiError) as exc_info:
            await client.list_projects()

    assert exc_info.value.error_code == "upstream_error"
    assert exc_info.value.retryable is False


@pytest.mark.asyncio
async def test_client_context_reuses_and_closes_session() -> None:
    client = GitLabExternalWikiClient(
        WikiSiteConfig(site_url="https://gitlab.example.com", api_key="test-token")
    )
    manager, session = _manager(_response(200, []))

    with patch(
        "app.services.wiki.connectors.gitlab_client.AsyncSessionManager",
        return_value=manager,
    ) as manager_class:
        async with client:
            await client.list_projects()
            await client.list_projects()

    manager_class.assert_called_once()
    manager.__aenter__.assert_awaited_once()
    assert session.request.call_count == 2
    manager.__aexit__.assert_awaited_once()


@pytest.mark.asyncio
async def test_wiki_responses_are_bounded() -> None:
    client = GitLabExternalWikiClient(
        WikiSiteConfig(site_url="https://gitlab.example.com", api_key="test-token")
    )
    client._request = AsyncMock(side_effect=[([], {}), ({}, {})])

    await client.list_project_wikis("group/project")
    await client.get_project_wiki("group/project", slug="runbook")

    list_limit = client._request.await_args_list[0].kwargs["max_bytes"]
    page_limit = client._request.await_args_list[1].kwargs["max_bytes"]
    assert list_limit > 0
    assert page_limit > 0
    assert (
        client._request.await_args_list[1].kwargs["response_too_large_code"]
        == "external_file_too_large"
    )


@pytest.mark.asyncio
async def test_repository_file_response_is_bounded(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "app.services.wiki.connectors.gitlab_client.settings.MAX_UPLOAD_FILE_SIZE_MB",
        0,
    )
    client = GitLabExternalWikiClient(
        WikiSiteConfig(site_url="https://gitlab.example.com", api_key="test-token")
    )
    manager, _ = _manager(_response(200, {"content": "x" * (1024 * 1024)}))

    with patch(
        "app.services.wiki.connectors.gitlab_client.AsyncSessionManager",
        return_value=manager,
    ):
        with pytest.raises(WikiApiError) as exc_info:
            await client.get_repository_file(
                "group/project",
                path="large.pdf",
                ref="main",
            )

    assert exc_info.value.error_code == "external_file_too_large"


@pytest.mark.asyncio
async def test_repository_file_response_limit_allows_folded_base64(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    file_limit = 50 * 1024 * 1024
    monkeypatch.setattr(
        "app.services.wiki.connectors.gitlab_client.settings.MAX_UPLOAD_FILE_SIZE_MB",
        50,
    )
    client = GitLabExternalWikiClient(
        WikiSiteConfig(site_url="https://gitlab.example.com", api_key="test-token")
    )
    client._request = AsyncMock(return_value=({}, {}))

    await client.get_repository_file(
        "group/project",
        path="large.pdf",
        ref="main",
    )

    encoded_limit = math.ceil(file_limit / 3) * 4
    folded_crlf_overhead = math.ceil(encoded_limit / 60) * 4
    max_bytes = client._request.await_args.kwargs["max_bytes"]
    assert max_bytes >= encoded_limit + folded_crlf_overhead + 1024 * 1024
