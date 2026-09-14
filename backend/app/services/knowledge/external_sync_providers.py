# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Provider seam for versioned external documents synchronized into RAG."""

from __future__ import annotations

import asyncio
import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Sequence

from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.user import User
from app.services.knowledge.external_document_providers import (
    ExternalDocumentContent,
    ExternalDocumentFetchError,
    ExternalDocumentImportError,
    ExternalDocumentProvider,
    ExternalSourceUnavailableError,
    PreparedExternalDocumentFetch,
)
from app.services.wiki.connector import WikiApiError, WikiPageMeta, build_page_url
from app.services.wiki.service import WikiConnectionService

SYNC_CONFIG_KEY = "sync"
WIKI_SYNC_PROVIDER_ID = "wiki"
logger = logging.getLogger(__name__)

_WIKI_SYNC_ERROR_MESSAGES = {
    "bad_request": "Wiki 页面标识无效",
    "external_connection_unavailable": "Wiki 连接不可用",
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
class ExternalSyncLocator:
    provider_id: str
    connection_id: str
    resource_id: str


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
    value = f"v1:{locator.connection_id}:{locator.resource_id}"
    if len(value) > 255:
        raise ExternalDocumentImportError("External document identity is too long")
    return value


def decode_external_sync_resource_id(
    provider_id: str, value: str
) -> ExternalSyncLocator:
    prefix, separator, remainder = value.partition(":")
    connection_id, second_separator, resource_id = remainder.partition(":")
    if prefix != "v1" or not separator or not second_separator:
        raise ExternalDocumentFetchError("Invalid synchronized document identity")
    if not connection_id or not resource_id:
        raise ExternalDocumentFetchError("Invalid synchronized document identity")
    return ExternalSyncLocator(provider_id, connection_id, resource_id)


def get_document_sync_config(document: Any) -> dict[str, Any]:
    source_config = getattr(document, "source_config", None)
    if not isinstance(source_config, dict):
        return {}
    external = source_config.get("external")
    if not isinstance(external, dict):
        return {}
    sync = external.get(SYNC_CONFIG_KEY)
    return dict(sync) if isinstance(sync, dict) else {}


def is_synchronized_external_document(document: Any) -> bool:
    return bool(get_document_sync_config(document).get("enabled"))


class WikiExternalSyncProvider(ExternalSyncProvider, ExternalDocumentProvider):
    """Wiki.js adapter for initial import, daily inspection and body fetch."""

    provider_id = WIKI_SYNC_PROVIDER_ID

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
    ) -> list[ResolvedExternalDocument]:
        connection = WikiConnectionService.get_user_wiki_connection(
            owner, db=db, connection_id=connection_id
        )
        if connection is None:
            raise ExternalDocumentImportError("Wiki connection is unavailable")
        # End the API transaction before concurrent remote Wiki requests. Keep
        # the caller-owned session open because the import phase reuses it.
        db.commit()
        paths = [
            path
            for path in dict.fromkeys(item.strip().strip("/") for item in selections)
            if path
        ]
        semaphore = asyncio.Semaphore(8)

        async def resolve_path(path: str) -> ResolvedExternalDocument:
            try:
                async with semaphore:
                    page = await connection.connector.get_page_metadata_by_path(
                        connection.config, path
                    )
            except WikiApiError as exc:
                raise ExternalDocumentImportError(exc.message) from exc
            if page is None:
                raise ExternalDocumentImportError(f"Wiki page not found: {path}")
            locator = ExternalSyncLocator(
                self.provider_id, connection.connection_id, page.id
            )
            return ResolvedExternalDocument(
                locator=locator,
                title=page.title or page.path,
                source_url=build_page_url(connection.config.site_url, page.path),
                remote_version=page.updated_at or None,
                metadata={
                    "path": page.path,
                    "locale": page.locale or "",
                    "site_url": connection.config.site_url.rstrip("/"),
                },
            )

        return list(await asyncio.gather(*(resolve_path(path) for path in paths)))

    def prepare_remote_inspection(
        self, db: Session, candidates: Sequence[SyncCandidate]
    ) -> PreparedExternalSyncBatch:
        immediate: dict[int, RemoteDocumentState] = {}
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
            prepared_groups.append((connection, tuple(group)))
        return PreparedExternalSyncBatch(
            payload=tuple(prepared_groups),
            immediate_states=immediate,
            connection_names=connection_names,
        )

    async def inspect_remote_states(
        self, prepared: PreparedExternalSyncBatch
    ) -> dict[int, RemoteDocumentState]:
        results = dict(prepared.immediate_states)
        for connection, group in prepared.payload:
            try:
                probes = await connection.connector.inspect_page_metadata_by_ids(
                    connection.config,
                    [candidate.locator.resource_id for candidate in group],
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
            for candidate in group:
                probe = probes.get(candidate.locator.resource_id)
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
        if not page.updated_at:
            return RemoteDocumentState(
                exists=True,
                remote_version=None,
                error_code="external_version_unavailable",
                error_message=_wiki_sync_error_message("external_version_unavailable"),
                metadata={
                    "path": page.path,
                    "locale": page.locale or "",
                    "title": page.title,
                    "url": build_page_url(site_url, page.path),
                },
            )
        return RemoteDocumentState(
            True,
            page.updated_at or None,
            metadata={
                "path": page.path,
                "locale": page.locale or "",
                "title": page.title,
                "url": build_page_url(site_url, page.path),
            },
        )

    def prepare_content_fetch(
        self, db: Session, user: User, external_resource_id: str
    ) -> PreparedExternalDocumentFetch:
        locator = decode_external_sync_resource_id(
            self.provider_id, external_resource_id
        )
        connection = WikiConnectionService.get_user_wiki_connection(
            user, db=db, connection_id=locator.connection_id
        )
        if connection is None:
            raise ExternalDocumentFetchError("Wiki connection is unavailable")
        return PreparedExternalDocumentFetch(
            external_resource_id=external_resource_id,
            payload=(locator, connection),
        )

    async def fetch_prepared_content(
        self, prepared: PreparedExternalDocumentFetch
    ) -> ExternalDocumentContent:
        locator, connection = prepared.payload
        try:
            page = await connection.connector.get_page_by_id(
                connection.config, locator.resource_id
            )
        except WikiApiError as exc:
            raise ExternalDocumentFetchError(exc.message) from exc
        if page is None:
            raise ExternalSourceUnavailableError(
                "Wiki 源文档不存在",
                error_code="external_source_missing",
            )
        return ExternalDocumentContent(
            name=page.title or page.path,
            file_extension="md",
            content=page.content.encode("utf-8"),
            metadata={
                "provider": self.provider_id,
                "title": page.title,
                "url": build_page_url(connection.config.site_url, page.path),
                SYNC_CONFIG_KEY: {
                    "enabled": True,
                    "connection_id": locator.connection_id,
                    "resource_id": locator.resource_id,
                    "path": page.path,
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
