# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Provider seam for versioned external documents synchronized into RAG."""

from __future__ import annotations

import asyncio
import json
import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Sequence

from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.user import User
from app.services.knowledge.external_document_identity import (
    WIKI_PROVIDER_ID,
    ExternalDocumentIdentityError,
    ExternalSyncLocator,
)
from app.services.knowledge.external_document_identity import (
    decode_external_sync_resource_id as _decode_external_sync_resource_id,
)
from app.services.knowledge.external_document_identity import (
    encode_external_sync_resource_id as _encode_external_sync_resource_id,
)
from app.services.knowledge.external_document_providers import (
    DetachedExternalDocumentProvider,
    ExternalDocumentContent,
    ExternalDocumentFetchError,
    ExternalDocumentImportError,
    ExternalSourceUnavailableError,
    PreparedExternalDocumentFetch,
)
from app.services.wiki.connector import (
    StoredWikiResourceRef,
    WikiApiError,
    WikiPageMeta,
    build_page_url,
)
from app.services.wiki.service import WikiConnectionService

SYNC_CONFIG_KEY = "sync"
logger = logging.getLogger(__name__)

_WIKI_SYNC_ERROR_MESSAGES = {
    "bad_request": "Wiki 页面标识无效",
    "external_connection_unavailable": "Wiki 连接不可用",
    "external_file_empty": "外部文件为空",
    "external_file_too_large": "外部文件超过知识库上传大小限制",
    "external_rate_limited": "外部服务请求过于频繁",
    "external_scope_invalid": "外部文档的仓库或分支不可用",
    "external_sync_config_invalid": "外部文档同步配置无效",
    "external_version_unavailable": "Wiki 源文档缺少更新时间",
    "upstream_error": "Wiki 站点响应异常",
    "wiki_auth_failed": "Wiki 站点鉴权失败",
    "wiki_batch_result_missing": "Wiki 站点未返回文档状态",
    "wiki_lookup_unsupported": "当前 Wiki 连接器不支持批量检查",
    "wiki_page_forbidden": "无权访问 Wiki 源文档",
    "wiki_timeout": "访问 Wiki 站点超时",
    "wiki_unreachable": "无法连接 Wiki 站点",
}


def _wiki_sync_error_message(error_code: str | None) -> str:
    return _WIKI_SYNC_ERROR_MESSAGES.get(error_code or "", "Wiki 文档同步检查失败")


@dataclass(frozen=True)
class ResolvedExternalDocument:
    locator: ExternalSyncLocator
    title: str
    source_url: str | None
    remote_version: str | None
    metadata: dict[str, Any] = field(default_factory=dict)

    @property
    def encoded_resource_id(self) -> str:
        return encode_external_sync_resource_id(self.locator)

    def external_metadata(self) -> dict[str, Any]:
        return {
            "provider": self.locator.provider_id,
            "resource_id": self.encoded_resource_id,
            "title": self.title,
            "url": self.source_url,
            SYNC_CONFIG_KEY: {
                "enabled": True,
                "connection_id": self.locator.connection_id,
                "resource_id": self.locator.resource_id,
                "observed_version": self.remote_version,
                "content_version": None,
                "indexed_version": None,
                **self.metadata,
            },
        }


@dataclass(frozen=True)
class SyncCandidate:
    document_id: int
    owner_user_id: int
    locator: ExternalSyncLocator
    resource_ref: StoredWikiResourceRef | None = None


@dataclass(frozen=True)
class RemoteDocumentState:
    exists: bool
    remote_version: str | None
    metadata: dict[str, Any] = field(default_factory=dict)
    error_code: str | None = None
    error_message: str | None = None


@dataclass(frozen=True)
class PreparedExternalSyncBatch:
    """Detached provider payload plus states resolved without remote I/O."""

    payload: Any = field(repr=False)
    immediate_states: dict[int, RemoteDocumentState] = field(default_factory=dict)
    skipped_document_ids: frozenset[int] = field(default_factory=frozenset)
    connection_names: dict[tuple[int, str], str] = field(default_factory=dict)


class ExternalSyncProvider(ABC):
    provider_id: str

    @abstractmethod
    async def resolve_selections(
        self,
        db: Session,
        owner: User,
        connection_id: str,
        selections: Sequence[str],
        *,
        project_path: str | None = None,
        branch: str | None = None,
    ) -> list[ResolvedExternalDocument]:
        """Resolve server-owned metadata for selected provider resources."""

    @abstractmethod
    def prepare_remote_inspection(
        self, db: Session, candidates: Sequence[SyncCandidate]
    ) -> PreparedExternalSyncBatch:
        """Resolve credentials inside a short database transaction."""

    @abstractmethod
    async def inspect_remote_states(
        self, prepared: PreparedExternalSyncBatch
    ) -> dict[int, RemoteDocumentState]:
        """Inspect a detached batch without using a database Session."""


def encode_external_sync_resource_id(locator: ExternalSyncLocator) -> str:
    try:
        return _encode_external_sync_resource_id(locator)
    except ExternalDocumentIdentityError as exc:
        raise ExternalDocumentImportError(str(exc)) from exc


def decode_external_sync_resource_id(
    provider_id: str, value: str
) -> ExternalSyncLocator:
    try:
        return _decode_external_sync_resource_id(provider_id, value)
    except ExternalDocumentIdentityError as exc:
        raise ExternalDocumentFetchError(str(exc)) from exc


def get_document_sync_config(document: Any) -> dict[str, Any]:
    source_config = getattr(document, "source_config", None)
    if not isinstance(source_config, dict):
        return {}
    external = source_config.get("external")
    if not isinstance(external, dict):
        return {}
    sync = external.get(SYNC_CONFIG_KEY)
    return dict(sync) if isinstance(sync, dict) else {}


def build_wiki_resource_ref(
    provider_id: str,
    encoded_resource_id: str,
    sync: dict[str, Any],
    *,
    expected_adapter_type: str | None = None,
) -> tuple[ExternalSyncLocator, StoredWikiResourceRef]:
    """Validate persisted Wiki sync metadata and restore its remote locator."""
    locator = decode_external_sync_resource_id(provider_id, encoded_resource_id)
    connection_id = str(sync.get("connection_id") or "")
    resource_id = str(sync.get("resource_id") or "")
    if not sync.get("enabled") or connection_id != locator.connection_id:
        raise ExternalDocumentFetchError("Invalid synchronized document metadata")

    adapter_type = str(sync.get("adapter_type") or expected_adapter_type or "")
    if expected_adapter_type and adapter_type != expected_adapter_type:
        raise ExternalDocumentFetchError("Invalid synchronized document metadata")

    if locator.identity_version == "v1":
        if resource_id != locator.resource_id:
            raise ExternalDocumentFetchError("Invalid synchronized document metadata")
        return locator, StoredWikiResourceRef(
            identity=encoded_resource_id,
            resource_id=resource_id,
            adapter_type=adapter_type or "wikijs",
            resource_kind=str(sync.get("resource_kind") or "page"),
            resource_key=str(sync.get("resource_key") or resource_id),
            path=str(sync.get("path") or resource_id),
            project_path=(
                str(sync["project_path"]) if sync.get("project_path") else None
            ),
            branch=str(sync["branch"]) if sync.get("branch") else None,
            file_extension=str(sync.get("file_extension") or ""),
        )

    resource_kind = str(sync.get("resource_kind") or "")
    resource_key = str(sync.get("resource_key") or "")
    project_path = str(sync.get("project_path") or "")
    path = str(sync.get("path") or "")
    branch = str(sync.get("branch") or "") or None
    required = adapter_type and resource_id and resource_key and project_path and path
    if not required or resource_kind != locator.resource_kind:
        raise ExternalDocumentFetchError("Invalid synchronized document metadata")
    if adapter_type == "gitlab_repo":
        expected_resource_key = [project_path, branch, path]
        valid_adapter_metadata = resource_kind == "file" and branch is not None
    elif adapter_type == "gitlab_wiki":
        expected_resource_key = [project_path, path]
        valid_adapter_metadata = resource_kind == "page" and branch is None
    else:
        expected_resource_key = []
        valid_adapter_metadata = False
    try:
        resource_key_parts = json.loads(resource_key)
    except (TypeError, ValueError):
        resource_key_parts = None
    if (
        not valid_adapter_metadata
        or resource_id != path
        or resource_key_parts != expected_resource_key
    ):
        raise ExternalDocumentFetchError("Invalid synchronized document metadata")
    expected_identity = encode_external_sync_resource_id(
        ExternalSyncLocator(
            provider_id,
            connection_id,
            resource_key,
            resource_kind=resource_kind,
            identity_version="v2",
        )
    )
    if expected_identity != encoded_resource_id:
        raise ExternalDocumentFetchError("Invalid synchronized document metadata")
    return locator, StoredWikiResourceRef(
        identity=encoded_resource_id,
        resource_id=resource_id,
        adapter_type=adapter_type,
        resource_kind=resource_kind,
        resource_key=resource_key,
        path=path,
        project_path=project_path,
        branch=branch,
        file_extension=str(sync.get("file_extension") or ""),
    )


def is_synchronized_external_document(document: Any) -> bool:
    return bool(get_document_sync_config(document).get("enabled"))


class WikiExternalSyncProvider(
    ExternalSyncProvider,
    DetachedExternalDocumentProvider,
):
    """Wiki.js adapter for initial import, daily inspection and body fetch."""

    provider_id = WIKI_PROVIDER_ID

    def resolve_importable(
        self, db: Session, user: User, external_resource_id: str
    ) -> dict[str, Any]:
        """The legacy synchronous import endpoint cannot resolve remote Wiki I/O."""
        raise ExternalDocumentImportError(
            "Wiki documents must be imported through the Wiki selector"
        )

    async def resolve_selections(
        self,
        db: Session,
        owner: User,
        connection_id: str,
        selections: Sequence[str],
        *,
        project_path: str | None = None,
        branch: str | None = None,
    ) -> list[ResolvedExternalDocument]:
        connection = WikiConnectionService.get_user_wiki_connection(
            owner, db=db, connection_id=connection_id
        )
        if connection is None:
            raise ExternalDocumentImportError("Wiki connection is unavailable")
        # End the API transaction before concurrent remote Wiki requests. Keep
        # the caller-owned session open because the import phase reuses it.
        db.commit()
        resource_ids = [
            resource_id
            for resource_id in dict.fromkeys(item.strip() for item in selections)
            if resource_id
        ]
        adapter_type = connection.connector.connector_type
        semaphore = asyncio.Semaphore(
            1 if adapter_type in {"gitlab_repo", "gitlab_wiki"} else 8
        )

        async def resolve_resource(resource_id: str) -> ResolvedExternalDocument:
            try:
                async with semaphore:
                    page = await connection.connector.resolve_resource(
                        connection.config,
                        resource_id,
                        project_path=project_path,
                        branch=branch,
                    )
            except WikiApiError as exc:
                raise ExternalDocumentImportError(exc.message) from exc
            if page is None:
                raise ExternalDocumentImportError(
                    f"External Wiki resource not found: {resource_id}"
                )
            uses_v2_identity = adapter_type != "wikijs"
            locator = ExternalSyncLocator(
                self.provider_id,
                connection.connection_id,
                page.resource_key if uses_v2_identity else page.id,
                resource_kind=page.resource_kind if uses_v2_identity else "",
                identity_version="v2" if uses_v2_identity else "v1",
            )
            return ResolvedExternalDocument(
                locator=locator,
                title=page.title or page.path,
                source_url=page.source_url
                or build_page_url(connection.config.site_url, page.path),
                remote_version=page.updated_at or None,
                metadata={
                    "adapter_type": adapter_type,
                    "resource_kind": page.resource_kind,
                    "resource_key": page.resource_key or page.id,
                    "resource_id": page.id,
                    "path": page.path,
                    "project_path": project_path,
                    "branch": branch,
                    "file_extension": page.file_extension,
                    "locale": page.locale or "",
                    "site_url": connection.config.site_url.rstrip("/"),
                    "connection_revision": connection.revision,
                },
            )

        return list(
            await asyncio.gather(
                *(resolve_resource(resource_id) for resource_id in resource_ids)
            )
        )

    def preflight_resolved_import(
        self,
        db: Session,
        user: User,
        resolved_documents: list[ResolvedExternalDocument],
    ) -> None:
        """Lock the connection and reject metadata resolved from a stale revision."""
        snapshots = {
            (
                resolved.locator.connection_id,
                int(resolved.metadata.get("connection_revision", -1)),
            )
            for resolved in resolved_documents
        }
        if len(snapshots) != 1:
            raise ExternalDocumentImportError(
                "Wiki connection changed while pages were loading; please retry",
                status_code=409,
            )
        connection_id, expected_revision = snapshots.pop()
        connection = WikiConnectionService.lock_user_wiki_connection(
            user,
            db,
            connection_id,
        )
        if connection is None or connection.revision != expected_revision:
            raise ExternalDocumentImportError(
                "Wiki connection changed while pages were loading; please retry",
                status_code=409,
            )

    def prepare_remote_inspection(
        self, db: Session, candidates: Sequence[SyncCandidate]
    ) -> PreparedExternalSyncBatch:
        immediate: dict[int, RemoteDocumentState] = {}
        skipped_document_ids: set[int] = set()
        connection_names: dict[tuple[int, str], str] = {}
        groups: dict[tuple[int, str], list[SyncCandidate]] = {}
        for candidate in candidates:
            groups.setdefault(
                (candidate.owner_user_id, candidate.locator.connection_id), []
            ).append(candidate)

        prepared_groups: list[tuple[Any, tuple[SyncCandidate, ...]]] = []
        for (owner_id, connection_id), group in groups.items():
            owner = (
                db.query(User)
                .filter(User.id == owner_id, User.is_active.is_(True))
                .first()
            )
            connection = (
                WikiConnectionService.get_user_wiki_connection(
                    owner, db=db, connection_id=connection_id
                )
                if owner
                else None
            )
            connection_names[(owner_id, connection_id)] = (
                connection.display_name if connection is not None else connection_id
            )
            if connection is None:
                for candidate in group:
                    immediate[candidate.document_id] = RemoteDocumentState(
                        exists=True,
                        remote_version=None,
                        error_code="external_connection_unavailable",
                        error_message=_wiki_sync_error_message(
                            "external_connection_unavailable"
                        ),
                    )
                continue
            if (
                getattr(connection.connector, "supports_scheduled_sync", False)
                is not True
            ):
                skipped_document_ids.update(
                    candidate.document_id for candidate in group
                )
                continue
            prepared_groups.append((connection, tuple(group)))
        return PreparedExternalSyncBatch(
            payload=tuple(prepared_groups),
            immediate_states=immediate,
            skipped_document_ids=frozenset(skipped_document_ids),
            connection_names=connection_names,
        )

    async def inspect_remote_states(
        self, prepared: PreparedExternalSyncBatch
    ) -> dict[int, RemoteDocumentState]:
        results = dict(prepared.immediate_states)
        for connection, group in prepared.payload:
            resources = [
                candidate.resource_ref
                or StoredWikiResourceRef(
                    identity=encode_external_sync_resource_id(candidate.locator),
                    resource_id=candidate.locator.resource_id,
                    adapter_type=connection.connector.connector_type,
                    resource_kind="page",
                    resource_key=candidate.locator.resource_id,
                    path=candidate.locator.resource_id,
                )
                for candidate in group
            ]
            try:
                probes = await connection.connector.inspect_resources(
                    connection.config,
                    resources,
                    batch_size=settings.WIKI_SYNC_REMOTE_BATCH_SIZE,
                )
            except WikiApiError as exc:
                for candidate in group:
                    results[candidate.document_id] = RemoteDocumentState(
                        exists=True,
                        remote_version=None,
                        error_code=exc.error_code,
                        error_message=exc.message,
                    )
                continue
            for candidate, resource in zip(group, resources, strict=True):
                probe = probes.get(resource.identity)
                if probe is None:
                    results[candidate.document_id] = RemoteDocumentState(
                        exists=True,
                        remote_version=None,
                        error_code="wiki_batch_result_missing",
                        error_message=_wiki_sync_error_message(
                            "wiki_batch_result_missing"
                        ),
                    )
                elif probe.page is not None:
                    results[candidate.document_id] = self._state_from_page(
                        connection.config.site_url, probe.page
                    )
                elif probe.confirmed_missing:
                    results[candidate.document_id] = RemoteDocumentState(
                        exists=False,
                        remote_version=None,
                        error_code="external_source_missing",
                    )
                else:
                    error_code = probe.error_code or "wiki_batch_result_missing"
                    results[candidate.document_id] = RemoteDocumentState(
                        exists=True,
                        remote_version=None,
                        error_code=error_code,
                        error_message=(
                            probe.error_message or _wiki_sync_error_message(error_code)
                        ),
                    )
        return results

    @staticmethod
    def _state_from_page(site_url: str, page: WikiPageMeta) -> RemoteDocumentState:
        metadata = {
            "path": page.path,
            "locale": page.locale or "",
            "title": page.title,
            "url": page.source_url or build_page_url(site_url, page.path),
            "resource_kind": page.resource_kind,
            "resource_key": page.resource_key,
            "file_extension": page.file_extension,
        }
        if not page.updated_at:
            return RemoteDocumentState(
                exists=True,
                remote_version=None,
                error_code="external_version_unavailable",
                error_message=_wiki_sync_error_message("external_version_unavailable"),
                metadata=metadata,
            )
        return RemoteDocumentState(
            True,
            page.updated_at or None,
            metadata=metadata,
        )

    def prepare_content_fetch(
        self,
        db: Session,
        user: User,
        external_resource_id: str,
        external_metadata: dict[str, Any] | None = None,
    ) -> PreparedExternalDocumentFetch:
        if getattr(user, "is_active", True) is not True:
            raise ExternalDocumentFetchError("Wiki document owner is disabled")
        locator = decode_external_sync_resource_id(
            self.provider_id, external_resource_id
        )
        connection = WikiConnectionService.get_user_wiki_connection(
            user, db=db, connection_id=locator.connection_id
        )
        if connection is None:
            raise ExternalDocumentFetchError("Wiki connection is unavailable")
        sync = (
            dict(external_metadata.get(SYNC_CONFIG_KEY) or {})
            if isinstance(external_metadata, dict)
            else {}
        )
        if not sync and locator.identity_version == "v1":
            sync = {
                "enabled": True,
                "connection_id": locator.connection_id,
                "resource_id": locator.resource_id,
            }
        locator, resource = build_wiki_resource_ref(
            self.provider_id,
            external_resource_id,
            sync,
            expected_adapter_type=connection.connector.connector_type,
        )
        return PreparedExternalDocumentFetch(
            external_resource_id=external_resource_id,
            payload=(locator, connection, resource),
        )

    async def fetch_prepared_content(
        self, prepared: PreparedExternalDocumentFetch
    ) -> ExternalDocumentContent:
        locator, connection, resource = prepared.payload
        try:
            fetched = await connection.connector.fetch_resource(
                connection.config, resource
            )
        except WikiApiError as exc:
            raise ExternalDocumentFetchError(
                exc.message,
                error_code=exc.error_code,
                retryable=exc.retryable,
            ) from exc
        if fetched is None:
            raise ExternalSourceUnavailableError(
                "Wiki 源文档不存在",
                error_code="external_source_missing",
            )
        page = fetched.meta
        return ExternalDocumentContent(
            name=page.title or page.path,
            file_extension=fetched.file_extension,
            content=fetched.content,
            metadata={
                "provider": self.provider_id,
                "title": page.title,
                "url": page.source_url
                or build_page_url(connection.config.site_url, page.path),
                SYNC_CONFIG_KEY: {
                    "enabled": True,
                    "connection_id": locator.connection_id,
                    "resource_id": resource.resource_id,
                    "adapter_type": resource.adapter_type,
                    "resource_kind": resource.resource_kind,
                    "resource_key": resource.resource_key,
                    "path": page.path,
                    "project_path": resource.project_path,
                    "branch": resource.branch,
                    "file_extension": fetched.file_extension,
                    "locale": page.locale or "",
                    "site_url": connection.config.site_url.rstrip("/"),
                    "observed_version": page.updated_at or None,
                    "content_version": page.updated_at or None,
                },
            },
        )


_SYNC_PROVIDERS: dict[str, ExternalSyncProvider] = {}


def register_external_sync_provider(provider: ExternalSyncProvider) -> None:
    _SYNC_PROVIDERS[provider.provider_id] = provider


def get_external_sync_provider(provider_id: str) -> ExternalSyncProvider | None:
    return _SYNC_PROVIDERS.get((provider_id or "").strip().lower())


def list_external_sync_provider_ids() -> tuple[str, ...]:
    """Return registered providers in deterministic order for the coordinator."""
    return tuple(sorted(_SYNC_PROVIDERS))


wiki_external_sync_provider = WikiExternalSyncProvider()
register_external_sync_provider(wiki_external_sync_provider)
