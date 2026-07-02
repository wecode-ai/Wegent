# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Unavailable external knowledge provider used for startup-safe degradation."""

from app.schemas.external_knowledge import (
    ExternalKnowledgeBindingLevel,
    ExternalKnowledgeRef,
)
from app.services.rag.sources import (
    ExternalKnowledgeDocumentListResult,
    ExternalRefValidationError,
    RetrievalContext,
    RetrievalSourceResult,
)
from wecode.schemas.external_knowledge import (
    ExternalKbNodesResponse,
    ExternalKnowledgeBaseListResponse,
    ExternalSearchResult,
)
from wecode.service.external_knowledge.base import ExternalKnowledgeProvider
from wecode.service.external_knowledge.exceptions import ExternalKnowledgeError


class UnavailableExternalKnowledgeProvider(ExternalKnowledgeProvider):
    """Provider placeholder that preserves app startup when registration fails."""

    def __init__(self, name: str, reason: str) -> None:
        self.name = name
        self.unavailable_reason = reason

    async def health(self) -> bool:
        return False

    async def list_knowledge_bases(
        self,
        employee_id: str,
        *,
        scope: str,
        query: str | None,
        limit: int,
        offset: int,
    ) -> ExternalKnowledgeBaseListResponse:
        raise self._error()

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
        raise self._error()

    async def search(
        self,
        employee_id: str,
        *,
        query: str,
        knowledge_base_ids: list[str],
        max_results: int,
    ) -> ExternalSearchResult:
        raise self._error()

    async def resolve_preview_url(
        self,
        employee_id: str,
        *,
        kb_id: str,
        node_id: str | None,
        document_id: str | None,
        folder_id: str | None,
    ) -> str:
        raise self._error()

    async def retrieve(
        self,
        query: str,
        refs: list[ExternalKnowledgeRef],
        ctx: RetrievalContext,
    ) -> RetrievalSourceResult:
        raise self._error()

    async def list_documents(
        self,
        refs: list[ExternalKnowledgeRef],
        ctx: RetrievalContext,
        *,
        limit: int,
        offset: int,
    ) -> ExternalKnowledgeDocumentListResult:
        raise self._error()

    def validate_refs(
        self,
        refs: list[ExternalKnowledgeRef],
        *,
        binding_level: ExternalKnowledgeBindingLevel,
    ) -> None:
        raise ExternalRefValidationError(self.unavailable_reason)

    def classify_preview_mode(self, url: str) -> str:
        return "iframe"

    def raw_debug_fields(self) -> set[str]:
        return set()

    def build_source_uri(self, kb_id: str, document_id: str) -> str:
        return f"{self.name}://{kb_id}/{document_id}"

    def _error(self) -> ExternalKnowledgeError:
        return ExternalKnowledgeError(
            self.unavailable_reason,
            code="provider_unavailable",
            status_code=503,
        )
