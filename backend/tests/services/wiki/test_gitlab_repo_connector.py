# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for GitLab repository external knowledge resources."""

import base64
from unittest.mock import AsyncMock, patch

import pytest

from app.core.config import settings
from app.services.wiki.connector import (
    StoredWikiResourceRef,
    WikiApiError,
    WikiSiteConfig,
)
from app.services.wiki.connectors.gitlab_repo import GitLabRepoConnector


def _config() -> WikiSiteConfig:
    return WikiSiteConfig(
        site_url="http://gitlab.internal",
        api_key="test-token",
    )


def _resource(path: str = "docs/guide.md") -> StoredWikiResourceRef:
    return StoredWikiResourceRef(
        identity="identity",
        resource_id=path,
        adapter_type="gitlab_repo",
        resource_kind="file",
        path=path,
        project_path="group/project",
        branch="main",
    )


def test_directory_is_not_treated_as_an_importable_file() -> None:
    meta = GitLabRepoConnector._meta(
        _config(),
        "group/project",
        "main",
        {"type": "tree", "path": "docs.v2", "name": "docs.v2"},
    )

    assert meta.is_directory is True
    assert meta.importable is False
    assert meta.file_extension == ""
    assert meta.unsupported_reason is None


@pytest.mark.asyncio
async def test_fetch_resource_decodes_base64_content() -> None:
    client = AsyncMock()
    client.get_repository_file.return_value = {
        "file_name": "guide.md",
        "blob_id": "blob-1",
        "size": 5,
        "encoding": "base64",
        "content": base64.b64encode(b"hello").decode(),
    }

    with patch(
        "app.services.wiki.connectors.gitlab_repo.GitLabExternalWikiClient",
        return_value=client,
    ):
        fetched = await GitLabRepoConnector().fetch_resource(_config(), _resource())

    assert fetched is not None
    assert fetched.content == b"hello"
    assert fetched.file_extension == "md"


@pytest.mark.asyncio
async def test_fetch_resource_rejects_reported_oversized_file(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "MAX_UPLOAD_FILE_SIZE_MB", 1)
    client = AsyncMock()
    client.get_repository_file.return_value = {
        "file_name": "guide.pdf",
        "size": 1024 * 1024 + 1,
        "encoding": "base64",
        "content": "",
    }

    with patch(
        "app.services.wiki.connectors.gitlab_repo.GitLabExternalWikiClient",
        return_value=client,
    ):
        with pytest.raises(WikiApiError) as exc_info:
            await GitLabRepoConnector().fetch_resource(
                _config(), _resource("docs/guide.pdf")
            )

    assert exc_info.value.error_code == "external_file_too_large"


@pytest.mark.asyncio
async def test_fetch_resource_rejects_empty_file() -> None:
    client = AsyncMock()
    client.get_repository_file.return_value = {
        "file_name": "guide.md",
        "size": 0,
        "encoding": "base64",
        "content": "",
    }

    with patch(
        "app.services.wiki.connectors.gitlab_repo.GitLabExternalWikiClient",
        return_value=client,
    ):
        with pytest.raises(WikiApiError) as exc_info:
            await GitLabRepoConnector().fetch_resource(_config(), _resource())

    assert exc_info.value.error_code == "external_file_empty"
