# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Provider-neutral seam for importing external documents.

An external document provider resolves one external document — identified by
the requesting user plus a provider-scoped resource ID — into content that the
existing attachment / conversion / indexing pipeline can consume. DingTalk is
the first adapter; a new provider only registers an adapter here and reuses
the import state machine instead of duplicating it.
"""

from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy.orm import Session

from app.models.user import User

logger = logging.getLogger(__name__)


class ExternalDocumentImportError(Exception):
    """Validation failure for an external document import request.

    ``status_code`` is the HTTP status the API layer should surface.
    """

    def __init__(self, message: str, status_code: int = 400):
        super().__init__(message)
        self.status_code = status_code


class ExternalDocumentAlreadyImportedError(ExternalDocumentImportError):
    """The external document is already imported into the knowledge base."""

    def __init__(self, message: str):
        super().__init__(message, status_code=409)


class ExternalDocumentFetchError(RuntimeError):
    """Background fetch of external document content failed."""


class ExternalSourceUnavailableError(ExternalDocumentFetchError):
    """The external source no longer exists or the user lost access to it.

    Raised by ``fetch_content`` when the provider can positively tell the
    resource is gone (or permission was revoked). The import marks the
    document's source as inaccessible while keeping the last successful
    snapshot; it is distinct from a transient fetch failure.
    """


class ExternalImportLostWriteError(RuntimeError):
    """The import attempt lost its write right before attaching content.

    Raised when the guarded attachment write finds the document deleted,
    superseded by a newer generation, or no longer carrying the external
    identity this attempt was dispatched for. The caller must clean up the
    attachment created by this attempt and leave the document untouched.
    """


@dataclass(frozen=True)
class ExternalDocumentContent:
    """Fetched content of one external document, ready for the RAG pipeline."""

    name: str
    file_extension: str
    content: bytes
    # Provider metadata persisted into the document's source_config["external"]
    metadata: dict[str, Any] = field(default_factory=dict)


class ExternalDocumentProvider(ABC):
    """Contract every external document provider adapter must fulfil."""

    provider_id: str

    @abstractmethod
    def is_configured(self, user: User) -> bool:
        """Return whether the user has this provider capability configured."""

    @abstractmethod
    def resolve_importable(
        self,
        db: Session,
        user: User,
        external_resource_id: str,
    ) -> dict[str, Any]:
        """Validate the external resource and return its display metadata.

        Raises ExternalDocumentImportError when the resource does not exist
        for this user or cannot be imported.
        """

    @abstractmethod
    async def fetch_content(
        self,
        db: Session,
        user: User,
        external_resource_id: str,
    ) -> ExternalDocumentContent:
        """Fetch the document body as attachment-ready content.

        Raises ExternalSourceUnavailableError when the provider can tell the
        resource is gone or access was revoked, ExternalDocumentFetchError
        for transient failures.
        """


class DingTalkExternalDocumentProvider(ExternalDocumentProvider):
    """DingTalk adapter backed by the user's DingTalk Docs MCP server."""

    provider_id = "dingtalk"

    def is_configured(self, user: User) -> bool:
        from app.services.dingtalk_doc_service import DingTalkDocService

        return DingTalkDocService.is_configured(user)

    def resolve_importable(
        self,
        db: Session,
        user: User,
        external_resource_id: str,
    ) -> dict[str, Any]:
        from app.models.dingtalk_doc import DingtalkSyncedNode
        from app.services.dingtalk_doc_service import DingTalkDocService

        node = (
            db.query(DingtalkSyncedNode)
            .filter(
                DingtalkSyncedNode.user_id == user.id,
                DingtalkSyncedNode.dingtalk_node_id == external_resource_id,
                DingtalkSyncedNode.is_active == True,  # noqa: E712
            )
            .first()
        )
        if node is None:
            raise ExternalDocumentImportError(
                "DingTalk document not found in your synced nodes", status_code=404
            )
        if node.node_type != "doc":
            raise ExternalDocumentImportError(
                "Only DingTalk online documents can be imported"
            )
        if not DingTalkDocService.is_configured(user):
            raise ExternalDocumentImportError(
                "DingTalk Docs is not configured for this account"
            )
        return {
            "provider": self.provider_id,
            "resource_id": node.dingtalk_node_id,
            "title": node.name,
            "url": node.doc_url,
        }

    async def fetch_content(
        self,
        db: Session,
        user: User,
        external_resource_id: str,
    ) -> ExternalDocumentContent:
        from app.services.dingtalk_doc_service import DingTalkDocService

        try:
            metadata = self.resolve_importable(db, user, external_resource_id)
        except ExternalDocumentImportError as exc:
            if exc.status_code == 404:
                # The synced node is gone or inactive: the source itself is
                # no longer accessible, not a transient fetch failure.
                raise ExternalSourceUnavailableError(str(exc)) from exc
            raise ExternalDocumentFetchError(str(exc)) from exc
        mcp_url = DingTalkDocService.get_user_dingtalk_mcp_url(user)
        if not mcp_url:
            raise ExternalDocumentFetchError(
                "DingTalk Docs MCP URL is not configured or not enabled"
            )
        markdown = await self._fetch_document_markdown(mcp_url, external_resource_id)
        return ExternalDocumentContent(
            name=metadata["title"],
            file_extension="md",
            content=markdown.encode("utf-8"),
            metadata=metadata,
        )

    async def _fetch_document_markdown(self, mcp_url: str, node_id: str) -> str:
        """Call the docs MCP get_document_content tool and return its Markdown."""
        try:
            from mcp import ClientSession
            from mcp.client.streamable_http import streamablehttp_client
        except ImportError:
            logger.error("mcp package not available for DingTalk document import")
            raise

        async with streamablehttp_client(url=mcp_url) as (
            read_stream,
            write_stream,
            _,
        ):
            async with ClientSession(read_stream, write_stream) as session:
                await session.initialize()
                result = await session.call_tool(
                    "get_document_content", {"nodeId": node_id}
                )

        if getattr(result, "isError", False):
            raise ExternalDocumentFetchError(
                "DingTalk MCP returned an error for get_document_content"
            )

        texts = [
            getattr(item, "text", "")
            for item in getattr(result, "content", None) or []
            if getattr(item, "type", None) == "text"
        ]
        markdown = "\n".join(text for text in texts if text).strip()
        if not markdown:
            raise ExternalDocumentFetchError(
                "DingTalk document content is empty or unreadable"
            )
        return markdown


_EXTERNAL_DOCUMENT_PROVIDERS: dict[str, ExternalDocumentProvider] = {}


def register_external_document_provider(provider: ExternalDocumentProvider) -> None:
    """Register a provider adapter under its provider_id."""
    _EXTERNAL_DOCUMENT_PROVIDERS[provider.provider_id] = provider


def get_external_document_provider(
    provider_id: str,
) -> ExternalDocumentProvider | None:
    """Return the registered adapter for a provider ID, or None."""
    return _EXTERNAL_DOCUMENT_PROVIDERS.get((provider_id or "").strip().lower())


register_external_document_provider(DingTalkExternalDocumentProvider())
