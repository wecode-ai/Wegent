# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""GitLab repository files as synchronized external knowledge documents."""

from __future__ import annotations

import asyncio
import base64
import binascii
from collections.abc import Sequence
from pathlib import PurePosixPath
from urllib.parse import quote

from app.core.config import settings
from app.services.knowledge.importable_file_types import classify_importable_file
from app.services.wiki.connector import (
    StoredWikiResourceRef,
    WikiApiError,
    WikiBranch,
    WikiConnectionTest,
    WikiConnector,
    WikiConnectorCapabilities,
    WikiPageMeta,
    WikiPageProbe,
    WikiProject,
    WikiResourceContent,
    WikiSiteConfig,
)
from app.services.wiki.connectors.gitlab_client import (
    GitLabExternalWikiClient,
    canonical_resource_key,
)

GITLAB_REPO_IMPORT_EXTENSIONS = frozenset(
    {
        "pdf",
        "doc",
        "docx",
        "ppt",
        "pptx",
        "xls",
        "xlsx",
        "csv",
        "txt",
        "md",
        "markdown",
    }
)


class GitLabRepoConnector(WikiConnector):
    supports_scheduled_sync = True
    connector_type = "gitlab_repo"
    display_name = "GitLab Repo"
    capabilities = WikiConnectorCapabilities(
        resource_kind="file",
        supports_project_selection=True,
        supports_branch_selection=True,
        supports_scheduled_sync=True,
    )

    @staticmethod
    def _source_url(
        config: WikiSiteConfig, project_path: str, branch: str, path: str
    ) -> str:
        return (
            f"{config.site_url.rstrip('/')}/{quote(project_path, safe='/')}/-/blob/"
            f"{quote(branch, safe='')}/{quote(path, safe='/')}"
        )

    @staticmethod
    def _meta(
        config: WikiSiteConfig,
        project_path: str,
        branch: str,
        node: dict,
    ) -> WikiPageMeta:
        path = str(node.get("file_path") or node.get("path") or "")
        name = str(
            node.get("file_name") or node.get("name") or PurePosixPath(path).name
        )
        is_directory = str(node.get("type") or "") == "tree"
        decision = classify_importable_file(
            name, allowed_extensions=GITLAB_REPO_IMPORT_EXTENSIONS
        )
        return WikiPageMeta(
            id=path,
            path=path,
            title=name,
            updated_at=str(node.get("blob_id") or node.get("id") or ""),
            resource_kind="file",
            resource_key=canonical_resource_key([project_path, branch, path]),
            file_extension="" if is_directory else decision.normalized_extension,
            importable=not is_directory and decision.importable,
            unsupported_reason=(
                None if is_directory or decision.importable else decision.reason
            ),
            is_directory=is_directory,
            source_url=GitLabRepoConnector._source_url(
                config, project_path, branch, path
            ),
        )

    async def test_connection(self, config: WikiSiteConfig) -> WikiConnectionTest:
        try:
            projects = await GitLabExternalWikiClient(config).list_projects(limit=1)
        except WikiApiError as exc:
            return WikiConnectionTest(False, exc.message)
        message = (
            "连接成功" if projects.items else "连接成功，但当前 AppKey 没有可访问项目"
        )
        return WikiConnectionTest(True, message)

    async def list_projects(
        self,
        config: WikiSiteConfig,
        *,
        search: str = "",
        limit: int = 100,
        offset: int = 0,
    ) -> tuple[list[WikiProject], int | None]:
        page = await GitLabExternalWikiClient(config).list_projects(
            search=search, limit=limit, offset=offset
        )
        return (
            [
                WikiProject(
                    path=str(item.get("path_with_namespace") or ""),
                    name=str(
                        item.get("name_with_namespace")
                        or item.get("path_with_namespace")
                        or ""
                    ),
                    default_branch=(
                        str(item["default_branch"])
                        if item.get("default_branch")
                        else None
                    ),
                    web_url=str(item.get("web_url") or ""),
                )
                for item in page.items
                if item.get("path_with_namespace")
            ],
            page.next_offset,
        )

    async def list_branches(
        self,
        config: WikiSiteConfig,
        project_path: str,
        *,
        limit: int = 100,
        offset: int = 0,
    ) -> tuple[list[WikiBranch], int | None]:
        client = GitLabExternalWikiClient(config)
        project, page = await asyncio.gather(
            client.get_project(project_path),
            client.list_branches(project_path, limit=limit, offset=offset),
        )
        default_branch = str(project.get("default_branch") or "")
        return (
            [
                WikiBranch(
                    name=str(item.get("name") or ""),
                    is_default=str(item.get("name") or "") == default_branch,
                )
                for item in page.items
                if item.get("name")
            ],
            page.next_offset,
        )

    async def list_pages(
        self,
        config: WikiSiteConfig,
        *,
        path: str | None = None,
        locale: str | None = None,
        limit: int,
        offset: int = 0,
        project_path: str | None = None,
        branch: str | None = None,
    ) -> tuple[list[WikiPageMeta], int | None]:
        if not project_path or not branch:
            raise WikiApiError("bad_request", "请选择 GitLab 仓库和分支")
        page = await GitLabExternalWikiClient(config).list_repository_tree(
            project_path,
            ref=branch,
            path=(path or "").strip("/"),
            limit=limit,
            offset=offset,
        )
        return (
            [
                self._meta(config, project_path, branch, item)
                for item in page.items
                if str(item.get("type") or "") in {"tree", "blob"}
            ],
            page.next_offset,
        )

    async def resolve_resource(
        self,
        config: WikiSiteConfig,
        resource_id: str,
        *,
        project_path: str | None = None,
        branch: str | None = None,
    ) -> WikiPageMeta | None:
        if not project_path or not branch:
            raise WikiApiError("bad_request", "请选择 GitLab 仓库和分支")
        decision = classify_importable_file(
            resource_id, allowed_extensions=GITLAB_REPO_IMPORT_EXTENSIONS
        )
        if not decision.importable:
            raise WikiApiError("unsupported_file_type", "该文件类型不支持导入")
        try:
            node = await GitLabExternalWikiClient(config).get_repository_file(
                project_path, path=resource_id, ref=branch
            )
        except WikiApiError as exc:
            if exc.error_code == "external_source_missing":
                return None
            raise
        if int(node.get("size") or 0) <= 0:
            raise WikiApiError("external_file_empty", "GitLab 文件为空")
        return self._meta(
            config,
            project_path,
            branch,
            {**node, "type": "blob", "path": resource_id},
        )

    async def inspect_resources(
        self,
        config: WikiSiteConfig,
        resources: Sequence[StoredWikiResourceRef],
        *,
        batch_size: int,
    ) -> dict[str, WikiPageProbe]:
        client = GitLabExternalWikiClient(config)
        results: dict[str, WikiPageProbe] = {}
        scopes = {
            (resource.project_path or "", resource.branch or "")
            for resource in resources
        }
        invalid_scopes: set[tuple[str, str]] = set()
        for project_path, branch in scopes:
            if not project_path or not branch:
                invalid_scopes.add((project_path, branch))
                continue
            try:
                await client.get_branch(project_path, branch)
            except WikiApiError as exc:
                invalid_scopes.add((project_path, branch))
                for resource in resources:
                    if (resource.project_path, resource.branch) == (
                        project_path,
                        branch,
                    ):
                        results[resource.identity] = WikiPageProbe(
                            error_code=exc.error_code,
                            error_message=exc.message,
                        )
        semaphore = asyncio.Semaphore(min(max(1, batch_size), 8))

        async def inspect(resource: StoredWikiResourceRef) -> None:
            scope = (resource.project_path or "", resource.branch or "")
            if scope in invalid_scopes:
                return
            try:
                async with semaphore:
                    headers = await client.get_repository_file_metadata(
                        scope[0], path=resource.path, ref=scope[1]
                    )
                meta = self._meta(
                    config,
                    scope[0],
                    scope[1],
                    {
                        "type": "blob",
                        "path": resource.path,
                        "blob_id": headers.get("x-gitlab-blob-id", ""),
                        "file_name": headers.get("x-gitlab-file-name", ""),
                    },
                )
                results[resource.identity] = WikiPageProbe(page=meta)
            except WikiApiError as exc:
                results[resource.identity] = WikiPageProbe(
                    confirmed_missing=exc.error_code == "external_source_missing",
                    error_code=(
                        None
                        if exc.error_code == "external_source_missing"
                        else exc.error_code
                    ),
                    error_message=exc.message,
                )

        await asyncio.gather(*(inspect(resource) for resource in resources))
        return results

    async def fetch_resource(
        self,
        config: WikiSiteConfig,
        resource: StoredWikiResourceRef,
    ) -> WikiResourceContent | None:
        if not resource.project_path or not resource.branch:
            raise WikiApiError("external_sync_config_invalid", "GitLab 同步配置不完整")
        try:
            node = await GitLabExternalWikiClient(config).get_repository_file(
                resource.project_path,
                path=resource.path,
                ref=resource.branch,
            )
        except WikiApiError as exc:
            if exc.error_code == "external_source_missing":
                return None
            raise
        if str(node.get("encoding") or "").lower() != "base64":
            raise WikiApiError("upstream_error", "GitLab 文件编码不受支持")
        limit = settings.MAX_UPLOAD_FILE_SIZE_MB * 1024 * 1024
        size = int(node.get("size") or 0)
        if size > limit:
            raise WikiApiError(
                "external_file_too_large",
                "GitLab 文件超过知识库上传大小限制",
            )
        try:
            content = base64.b64decode(str(node.get("content") or ""), validate=True)
        except (binascii.Error, ValueError) as exc:
            raise WikiApiError("upstream_error", "GitLab 文件内容无法解码") from exc
        if not content:
            raise WikiApiError("external_file_empty", "GitLab 文件为空")
        if len(content) > limit:
            raise WikiApiError(
                "external_file_too_large",
                "GitLab 文件超过知识库上传大小限制",
            )
        meta = self._meta(
            config,
            resource.project_path,
            resource.branch,
            {**node, "type": "blob", "path": resource.path},
        )
        return WikiResourceContent(meta, content, meta.file_extension)
