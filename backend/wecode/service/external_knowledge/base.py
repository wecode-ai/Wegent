# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Provider protocol for external knowledge browse APIs."""

from abc import ABC, abstractmethod
from typing import Any

from wecode.schemas.external_knowledge import (
    ExternalKbNodesResponse,
    ExternalKnowledgeBaseListResponse,
    ExternalPreviewResponse,
    ExternalSearchResult,
)


class ExternalKnowledgeProvider(ABC):
    """Read-only external knowledge browse provider."""

    name: str

    @abstractmethod
    async def health(self) -> bool:
        """Return whether the provider is reachable."""

    @abstractmethod
    async def list_knowledge_bases(
        self,
        employee_id: str,
        *,
        scope: str,
        query: str | None,
        limit: int,
        offset: int,
    ) -> ExternalKnowledgeBaseListResponse:
        """List knowledge bases visible to the employee."""

    @abstractmethod
    async def list_nodes(
        self,
        employee_id: str,
        *,
        kb_id: str,
        folder_id: str | None,
        recursive: bool,
        limit: int,
        offset: int,
    ) -> ExternalKbNodesResponse:
        """List nodes in a knowledge base."""

    @abstractmethod
    async def search(
        self,
        employee_id: str,
        *,
        query: str,
        knowledge_base_ids: list[str],
        max_results: int,
    ) -> ExternalSearchResult:
        """Search content in selected knowledge bases."""

    @abstractmethod
    async def resolve_preview_url(
        self,
        employee_id: str,
        *,
        kb_id: str,
        node_id: str | None,
        document_id: str | None,
        folder_id: str | None,
    ) -> str:
        """Resolve a raw preview URL after authorization."""

    @abstractmethod
    def classify_preview_mode(self, url: str) -> str:
        """Classify preview mode for a raw preview URL."""

    def build_preview(self, url: str | None) -> ExternalPreviewResponse | None:
        """Build the client-facing preview contract for a raw preview URL."""
        if not url:
            return None

        preview_mode = self.classify_preview_mode(url)
        if preview_mode not in {"iframe", "new_tab"}:
            preview_mode = "new_tab"
        return ExternalPreviewResponse(url=url, preview_mode=preview_mode)

    @abstractmethod
    def raw_debug_fields(self) -> set[str]:
        """Return raw field names that must never enter batch payloads."""

    @abstractmethod
    def build_source_uri(self, kb_id: str, document_id: str) -> str:
        """Build an opaque source URI for references."""


RawNode = dict[str, Any]
