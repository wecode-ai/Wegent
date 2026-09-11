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

from app.models.user import User
from app.services.knowledge.external_document_providers import (
    ExternalDocumentContent,
    ExternalDocumentFetchError,
    ExternalDocumentImportError,
    ExternalDocumentProvider,
    ExternalSourceUnavailableError,
)
from app.services.wiki.connector import WikiApiError, WikiPageMeta, build_page_url
from app.services.wiki.service import ResolvedWikiConnection, WikiConnectionService

SYNC_CONFIG_KEY = "sync"
WIKI_SYNC_PROVIDER_ID = "wiki"
_WIKI_LOOKUP_CONCURRENCY = 8

logger = logging.getLogger(__name__)


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
    async def inspect_remote_states(
        self, db: Session, candidates: Sequence[SyncCandidate]
    ) -> dict[int, RemoteDocumentState]:
        """Inspect a batch; every candidate must receive a result."""

    @abstractmethod
    async def fetch_content(
        self, db: Session, user: User, external_resource_id: str
    ) -> ExternalDocumentContent:
        """Fetch one resolved version for the shared external import worker."""


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
        resolved: list[ResolvedExternalDocument] = []
        for path in dict.fromkeys(item.strip().strip("/") for item in selections):
            if not path:
                continue
            try:
                page = await connection.connector.get_page(connection.config, path)
            except WikiApiError as exc:
                raise ExternalDocumentImportError(exc.message) from exc
            if page is None:
                raise ExternalDocumentImportError(f"Wiki page not found: {path}")
            locator = ExternalSyncLocator(
                self.provider_id, connection.connection_id, page.id
            )
            resolved.append(
                ResolvedExternalDocument(
                    locator=locator,
                    title=page.title or page.path,
                    source_url=build_page_url(connection.config.site_url, page.path),
                    remote_version=page.updated_at or None,
                    metadata={"path": page.path, "locale": page.locale or ""},
                )
            )
        return resolved

    async def inspect_remote_states(
        self, db: Session, candidates: Sequence[SyncCandidate]
    ) -> dict[int, RemoteDocumentState]:
        results: dict[int, RemoteDocumentState] = {}
        groups: dict[tuple[int, str], list[SyncCandidate]] = {}
        for candidate in candidates:
            groups.setdefault(
                (candidate.owner_user_id, candidate.locator.connection_id), []
            ).append(candidate)

        for (owner_id, connection_id), group in groups.items():
            owner = db.get(User, owner_id)
            connection = (
                WikiConnectionService.get_user_wiki_connection(
                    owner, db=db, connection_id=connection_id
                )
                if owner
                else None
            )
            if connection is None:
                for candidate in group:
                    results[candidate.document_id] = RemoteDocumentState(
                        exists=True,
                        remote_version=None,
                        error_code="external_connection_unavailable",
                    )
                continue
            try:
                pages, _ = await connection.connector.list_pages(
                    connection.config, limit=10_000
                )
            except WikiApiError as exc:
                for candidate in group:
                    results[candidate.document_id] = RemoteDocumentState(
                        exists=True,
                        remote_version=None,
                        error_code=exc.error_code,
                    )
                continue
            by_id = {page.id: page for page in pages}
            missing_ids = {
                candidate.locator.resource_id
                for candidate in group
                if candidate.locator.resource_id not in by_id
            }
            verified = await self._verify_unlisted_pages(connection, missing_ids)
            if missing_ids:
                logger.info(
                    "[External Wiki Sync] Checked %s pages individually after list miss",
                    len(missing_ids),
                )
            for candidate in group:
                page = by_id.get(candidate.locator.resource_id)
                results[candidate.document_id] = (
                    self._state_from_page(connection.config.site_url, page)
                    if page is not None
                    else verified[candidate.locator.resource_id]
                )
        return results

    @staticmethod
    def _state_from_page(site_url: str, page: WikiPageMeta) -> RemoteDocumentState:
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

    async def _verify_unlisted_pages(
        self, connection: ResolvedWikiConnection, resource_ids: set[str]
    ) -> dict[str, RemoteDocumentState]:
        semaphore = asyncio.Semaphore(_WIKI_LOOKUP_CONCURRENCY)

        async def verify(resource_id: str) -> tuple[str, RemoteDocumentState]:
            try:
                async with semaphore:
                    page = await connection.connector.get_page_metadata_by_id(
                        connection.config, resource_id
                    )
            except WikiApiError as exc:
                state = RemoteDocumentState(
                    exists=True,
                    remote_version=None,
                    error_code=exc.error_code,
                )
            else:
                state = (
                    self._state_from_page(connection.config.site_url, page)
                    if page is not None
                    else RemoteDocumentState(
                        exists=False,
                        remote_version=None,
                        error_code="external_source_missing",
                    )
                )
            return resource_id, state

        return dict(await asyncio.gather(*(verify(item) for item in resource_ids)))

    async def fetch_content(
        self, db: Session, user: User, external_resource_id: str
    ) -> ExternalDocumentContent:
        locator = decode_external_sync_resource_id(
            self.provider_id, external_resource_id
        )
        connection = WikiConnectionService.get_user_wiki_connection(
            user, db=db, connection_id=locator.connection_id
        )
        if connection is None:
            raise ExternalDocumentFetchError("Wiki connection is unavailable")
        try:
            meta = await connection.connector.get_page_metadata_by_id(
                connection.config, locator.resource_id
            )
            if meta is None:
                raise ExternalSourceUnavailableError(
                    "Wiki source document no longer exists",
                    error_code="external_source_missing",
                )
            page = await connection.connector.get_page(
                connection.config, meta.path, meta.locale or None
            )
        except WikiApiError as exc:
            raise ExternalDocumentFetchError(exc.message) from exc
        if page is None:
            raise ExternalSourceUnavailableError(
                "Wiki source document no longer exists",
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


wiki_external_sync_provider = WikiExternalSyncProvider()
register_external_sync_provider(wiki_external_sync_provider)
