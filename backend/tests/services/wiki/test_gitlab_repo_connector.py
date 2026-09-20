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


def _git_lfs_node() -> dict[str, object]:
    pointer = (
        b"version https://git-lfs.github.com/spec/v1\n"
        b"oid sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n"
        b"size 10485760\n"
    )
    return {
        "file_name": "guide.pdf",
        "blob_id": "blob-lfs",
        "size": len(pointer),
        "encoding": "base64",
        "content": base64.b64encode(pointer).decode(),
    }


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
async def test_fetch_resource_decodes_folded_base64_content() -> None:
    content = b"hello world" * 20
    client = AsyncMock()
    client.get_repository_file.return_value = {
        "file_name": "guide.md",
        "blob_id": "blob-1",
        "size": len(content),
        "encoding": "base64",
        "content": base64.encodebytes(content).decode(),
    }

    with patch(
        "app.services.wiki.connectors.gitlab_repo.GitLabExternalWikiClient",
        return_value=client,
    ):
        fetched = await GitLabRepoConnector().fetch_resource(_config(), _resource())

    assert fetched is not None
    assert fetched.content == content


@pytest.mark.asyncio
async def test_resolve_resource_uses_metadata_without_downloading_body() -> None:
    client = AsyncMock()
    client.get_repository_file_metadata.return_value = {
        "x-gitlab-blob-id": "blob-1",
        "x-gitlab-file-name": "guide.pdf",
        "x-gitlab-size": "1024",
    }

    with patch(
        "app.services.wiki.connectors.gitlab_repo.GitLabExternalWikiClient",
        return_value=client,
    ):
        resolved = await GitLabRepoConnector().resolve_resource(
            _config(),
            "docs/guide.pdf",
            project_path="group/project",
            branch="main",
        )

    assert resolved is not None
    assert resolved.updated_at == "blob-1"
    client.get_repository_file_metadata.assert_awaited_once()
    client.get_repository_file.assert_not_awaited()


@pytest.mark.asyncio
async def test_fetch_resource_rejects_git_lfs_pointer() -> None:
    client = AsyncMock()
    client.get_repository_file.return_value = _git_lfs_node()

    with patch(
        "app.services.wiki.connectors.gitlab_repo.GitLabExternalWikiClient",
        return_value=client,
    ):
        with pytest.raises(WikiApiError) as exc_info:
            await GitLabRepoConnector().fetch_resource(
                _config(), _resource("docs/guide.pdf")
            )

    assert exc_info.value.error_code == "unsupported_file_type"
    assert exc_info.value.retryable is False


@pytest.mark.asyncio
async def test_inspect_resources_reports_invalid_scope() -> None:
    resources = [
        StoredWikiResourceRef(
            identity="missing-project",
            resource_id="docs/project.md",
            adapter_type="gitlab_repo",
            resource_kind="file",
            path="docs/project.md",
            project_path="",
            branch="main",
        ),
        StoredWikiResourceRef(
            identity="missing-branch",
            resource_id="docs/branch.md",
            adapter_type="gitlab_repo",
            resource_kind="file",
            path="docs/branch.md",
            project_path="group/project",
            branch="",
        ),
    ]
    client = AsyncMock()

    with patch(
        "app.services.wiki.connectors.gitlab_repo.GitLabExternalWikiClient",
        return_value=client,
    ):
        probes = await GitLabRepoConnector().inspect_resources(
            _config(), resources, batch_size=20
        )

    assert set(probes) == {"missing-project", "missing-branch"}
    assert all(
        probe.error_code == "external_sync_config_invalid" for probe in probes.values()
    )
    client.get_branch.assert_not_awaited()
    client.get_repository_file_metadata.assert_not_awaited()


@pytest.mark.asyncio
async def test_inspect_resources_reuses_one_client_context() -> None:
    client = AsyncMock()
    client.__aenter__.return_value = client
    client.get_branch.return_value = {"name": "main"}
    client.get_repository_file_metadata.return_value = {
        "x-gitlab-blob-id": "blob-1",
        "x-gitlab-file-name": "guide.md",
    }

    with patch(
        "app.services.wiki.connectors.gitlab_repo.GitLabExternalWikiClient",
        return_value=client,
    ):
        probes = await GitLabRepoConnector().inspect_resources(
            _config(),
            [_resource()],
            batch_size=20,
        )

    assert probes[_resource().identity].page is not None
    client.__aenter__.assert_awaited_once()
    client.__aexit__.assert_awaited_once()


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
