# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for GitLab project Wiki external knowledge resources."""

from unittest.mock import AsyncMock, patch

import pytest

from app.services.wiki.connector import (
    StoredWikiResourceRef,
    WikiApiError,
    WikiSiteConfig,
)
from app.services.wiki.connectors.gitlab_wiki import GitLabWikiConnector, _wiki_version


def _config() -> WikiSiteConfig:
    return WikiSiteConfig(
        site_url="http://gitlab.internal",
        api_key="test-token",
    )


def _resource(identity: str, slug: str) -> StoredWikiResourceRef:
    return StoredWikiResourceRef(
        identity=identity,
        resource_id=slug,
        adapter_type="gitlab_wiki",
        resource_kind="page",
        path=slug,
        project_path="group/project",
    )


def test_wiki_content_version_is_stable_and_changes_with_content() -> None:
    page = {"title": "Runbook", "format": "markdown", "content": "# Hello"}

    assert _wiki_version(page) == _wiki_version(dict(page))
    assert _wiki_version(page) != _wiki_version({**page, "content": "# Updated"})


@pytest.mark.asyncio
async def test_large_content_list_falls_back_to_slug_list_and_bound_pages() -> None:
    existing = _resource("existing-identity", "docs/runbook")
    missing = _resource("missing-identity", "docs/missing")
    client = AsyncMock()
    client.list_project_wikis.side_effect = [
        WikiApiError(
            "external_response_too_large",
            "GitLab Wiki 页面列表响应过大",
        ),
        [{"slug": "docs/runbook", "title": "Runbook"}],
    ]
    client.get_project_wiki.return_value = {
        "slug": "docs/runbook",
        "title": "Runbook",
        "format": "markdown",
        "content": "# Hello",
    }

    with patch(
        "app.services.wiki.connectors.gitlab_wiki.GitLabExternalWikiClient",
        return_value=client,
    ):
        probes = await GitLabWikiConnector().inspect_resources(
            _config(),
            [existing, missing],
            batch_size=20,
        )

    assert probes["existing-identity"].page is not None
    assert probes["missing-identity"].confirmed_missing is True
    client.get_project_wiki.assert_awaited_once_with(
        "group/project",
        slug="docs/runbook",
    )
