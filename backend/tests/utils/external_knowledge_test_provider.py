# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Reusable provider for upstream external-knowledge integration tests."""

from app.api.endpoints.internal.rag import RetrieveRecord
from app.schemas.external_knowledge import ExternalKnowledgeRef
from app.services.rag.sources import (
    ExternalKnowledgeDocument,
    ExternalKnowledgeDocumentListResult,
    ExternalProviderCapabilities,
    ExternalRefGateRequest,
    ExternalRefValidationError,
    RetrievalContext,
    RetrievalSourceResult,
    RetrievalSourceStatus,
    RetrievalSourceSummary,
)


class UpstreamExternalKnowledgeTestProvider:
    """Deterministic provider that exercises registry-backed HTTP endpoints."""

    name = "test-external"
    capabilities = ExternalProviderCapabilities(
        enforces_per_user_access=True,
        supports_virtual_containers=True,
    )

    def validate_refs(self, *, gate: ExternalRefGateRequest) -> None:
        """Validate refs with user identity and agent binding constraints."""
        if gate.actor_user_id < 0:
            raise ExternalRefValidationError("Invalid actor user")
        for ref in gate.refs:
            if ref.mode == "all_accessible" and gate.binding_level == "agent":
                raise ExternalRefValidationError("Agent default refs must be explicit")
            if ref.id != "virtual-kb":
                raise ExternalRefValidationError("Unknown test source")

    async def retrieve(
        self,
        query: str,
        refs: list[ExternalKnowledgeRef],
        ctx: RetrievalContext,
    ) -> RetrievalSourceResult:
        """Return one deterministic record per selected source."""
        records = [
            RetrieveRecord(
                content=f"{query} result for user {ctx.user_id}",
                title="Test Document",
                score=0.93,
                source_type=self.name,
                source_id=ref.id,
                source_uri=f"{self.name}://{ref.id}/doc-1",
                source_name=ref.name or "Virtual Test KB",
                document_id=1,
            )
            for ref in refs
            if ref.id
        ]
        searched_ids = [ref.id for ref in refs if ref.id]
        return RetrievalSourceResult(
            records=records,
            summary=RetrievalSourceSummary(
                provider=self.name,
                searched_source_ids=searched_ids,
                ignored_source_ids=[],
                source_statuses=[
                    RetrievalSourceStatus(
                        provider=self.name,
                        source_id=source_id,
                        source_name="Virtual Test KB",
                        status="hit",
                        record_count=1,
                        citation_count=1,
                    )
                    for source_id in searched_ids
                ],
            ),
        )

    async def list_documents(
        self,
        refs: list[ExternalKnowledgeRef],
        ctx: RetrievalContext,
        *,
        limit: int,
        offset: int,
    ) -> ExternalKnowledgeDocumentListResult:
        """Expose a virtual-container document list."""
        documents = [
            ExternalKnowledgeDocument(
                provider=self.name,
                source_id=ref.id or "virtual-kb",
                source_name=ref.name or "Virtual Test KB",
                document_id="doc-1",
                title=f"Test Document for user {ctx.user_id}",
                node_id="node-1",
                parent_id="root",
                source_uri=f"{self.name}://{ref.id or 'virtual-kb'}/doc-1",
            )
            for ref in refs
        ]
        return ExternalKnowledgeDocumentListResult(
            documents=documents[offset : offset + limit]
        )
