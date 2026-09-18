# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""GitLab project Wiki pages as synchronized external knowledge documents."""

from __future__ import annotations

import asyncio
import hashlib
from collections.abc import Sequence
from urllib.parse import quote

from app.services.wiki.connector import (
    StoredWikiResourceRef,
    WikiApiError,
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


def _wiki_version(node: dict) -> str:
    value = "\0".join(
        (
            str(node.get("title") or ""),
            str(node.get("format") or ""),
            str(node.get("content") or ""),
        )
    )
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _wiki_extension(value: str) -> str:
    return {
        "markdown": "md",
        "asciidoc": "adoc",
        "rdoc": "txt",
        "org": "txt",
    }.get(value.lower(), "txt")


class GitLabWikiConnector(WikiConnector):
    supports_scheduled_sync = True
    connector_type = "gitlab_wiki"
    display_name = "GitLab Wiki"
    capabilities = WikiConnectorCapabilities(
        resource_kind="page",
        supports_project_selection=True,
        supports_scheduled_sync=True,
    )

    @staticmethod
    def _source_url(config: WikiSiteConfig, project_path: str, slug: str) -> str:
        return (
            f"{config.site_url.rstrip('/')}/{quote(project_path, safe='/')}/-/wikis/"
            f"{quote(slug, safe='/')}"
        )

    @staticmethod
    def _meta(config: WikiSiteConfig, project_path: str, node: dict) -> WikiPageMeta:
        slug = str(node.get("slug") or "")
        content_present = isinstance(node.get("content"), str)
        return WikiPageMeta(
            id=slug,
            path=slug,
            title=str(node.get("title") or slug),
            updated_at=_wiki_version(node) if content_present else "",
            resource_kind="page",
            resource_key=canonical_resource_key([project_path, slug]),
            file_extension=_wiki_extension(str(node.get("format") or "")),
            source_url=GitLabWikiConnector._source_url(config, project_path, slug),
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
        if not project_path:
            raise WikiApiError("bad_request", "请选择 GitLab 仓库")
        pages = await GitLabExternalWikiClient(config).list_project_wikis(project_path)
        metas = [self._meta(config, project_path, page) for page in pages]
        batch = metas[offset : offset + limit]
        next_offset = offset + limit if len(metas) > offset + limit else None
        return batch, next_offset

    async def resolve_resource(
        self,
        config: WikiSiteConfig,
        resource_id: str,
        *,
        project_path: str | None = None,
        branch: str | None = None,
    ) -> WikiPageMeta | None:
        if not project_path:
            raise WikiApiError("bad_request", "请选择 GitLab 仓库")
        try:
            node = await GitLabExternalWikiClient(config).get_project_wiki(
                project_path, slug=resource_id
            )
        except WikiApiError as exc:
            if exc.error_code == "external_source_missing":
                return None
            raise
        return self._meta(config, project_path, node)

    async def inspect_resources(
        self,
        config: WikiSiteConfig,
        resources: Sequence[StoredWikiResourceRef],
        *,
        batch_size: int,
    ) -> dict[str, WikiPageProbe]:
        client = GitLabExternalWikiClient(config)
        results: dict[str, WikiPageProbe] = {}
        by_project: dict[str, list[StoredWikiResourceRef]] = {}
        for resource in resources:
            by_project.setdefault(resource.project_path or "", []).append(resource)
        for project_path, group in by_project.items():
            if not project_path:
                for resource in group:
                    results[resource.identity] = WikiPageProbe(
                        error_code="external_sync_config_invalid",
                        error_message="GitLab Wiki 同步配置不完整",
                    )
                continue
            try:
                pages = await client.list_project_wikis(project_path, with_content=True)
                indexed = {
                    str(page.get("slug") or ""): page
                    for page in pages
                    if page.get("slug")
                }
                for resource in group:
                    node = indexed.get(resource.path)
                    results[resource.identity] = (
                        WikiPageProbe(page=self._meta(config, project_path, node))
                        if node is not None
                        else WikiPageProbe(confirmed_missing=True)
                    )
                continue
            except WikiApiError as exc:
                if exc.error_code != "external_response_too_large":
                    for resource in group:
                        results[resource.identity] = WikiPageProbe(
                            error_code=exc.error_code,
                            error_message=exc.message,
                        )
                    continue
            try:
                listed_pages = await client.list_project_wikis(project_path)
            except WikiApiError as exc:
                for resource in group:
                    results[resource.identity] = WikiPageProbe(
                        error_code=exc.error_code,
                        error_message=exc.message,
                    )
                continue
            available_slugs = {
                str(page.get("slug") or "") for page in listed_pages if page.get("slug")
            }
            existing_resources = []
            for resource in group:
                if resource.path not in available_slugs:
                    results[resource.identity] = WikiPageProbe(confirmed_missing=True)
                else:
                    existing_resources.append(resource)
            semaphore = asyncio.Semaphore(min(max(1, batch_size), 8))

            async def inspect(resource: StoredWikiResourceRef) -> None:
                try:
                    async with semaphore:
                        node = await client.get_project_wiki(
                            project_path, slug=resource.path
                        )
                    results[resource.identity] = WikiPageProbe(
                        page=self._meta(config, project_path, node)
                    )
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

            await asyncio.gather(
                *(inspect(resource) for resource in existing_resources)
            )
        return results

    async def fetch_resource(
        self,
        config: WikiSiteConfig,
        resource: StoredWikiResourceRef,
    ) -> WikiResourceContent | None:
        if not resource.project_path:
            raise WikiApiError(
                "external_sync_config_invalid", "GitLab Wiki 同步配置不完整"
            )
        try:
            node = await GitLabExternalWikiClient(config).get_project_wiki(
                resource.project_path, slug=resource.path
            )
        except WikiApiError as exc:
            if exc.error_code == "external_source_missing":
                return None
            raise
        content = str(node.get("content") or "").encode("utf-8")
        if not content:
            raise WikiApiError("external_file_empty", "GitLab Wiki 页面为空")
        meta = self._meta(config, resource.project_path, node)
        return WikiResourceContent(meta, content, meta.file_extension)
