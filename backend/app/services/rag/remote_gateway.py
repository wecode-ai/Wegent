# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Remote RAG Gateway for Knowledge Runtime.

This gateway sends requests to Knowledge Runtime using reference mode:
only passes references (user_id + kb_id/retriever_name), not full configurations.
The Knowledge Runtime resolves full configurations from the database.
"""

from __future__ import annotations

from typing import Any

import httpx
from pydantic import ValidationError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.services.rag.content_refs import build_content_ref_for_attachment
from app.services.rag.runtime_specs import (
    ConnectionTestRuntimeSpec,
    DeleteRuntimeSpec,
    DropKnowledgeIndexRuntimeSpec,
    IndexRuntimeSpec,
    ListChunksRuntimeSpec,
    PurgeKnowledgeRuntimeSpec,
    QueryRuntimeSpec,
)
from shared.models import (
    KnowledgeBaseReference,
    RemoteDeleteDocumentIndexRequest,
    RemoteDropKnowledgeIndexRequest,
    RemoteIndexRequest,
    RemoteListChunksRequest,
    RemoteListChunksResponse,
    RemotePurgeKnowledgeIndexRequest,
    RemoteQueryRequest,
    RemoteQueryResponse,
    RemoteRagError,
    RemoteTestConnectionRequest,
    RetrieverReference,
)


class RemoteRagGatewayError(RuntimeError):
    """Raised when knowledge_runtime returns an error response."""

    def __init__(
        self,
        message: str,
        *,
        code: str = "remote_request_failed",
        retryable: bool = False,
        status_code: int | None = None,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.retryable = retryable
        self.status_code = status_code
        self.details = details


def should_fallback_to_local(error: RemoteRagGatewayError) -> bool:
    """Return whether a remote error is safe to retry locally."""

    return error.retryable or (
        error.status_code is not None and error.status_code >= 500
    )


class RemoteRagGateway:
    def __init__(
        self,
        *,
        base_url: str | None = None,
        timeout: float = 30.0,
        auth_token: str | None = None,
    ) -> None:
        self._base_url = (base_url or settings.KNOWLEDGE_RUNTIME_URL).rstrip("/")
        self._timeout = timeout
        # Priority: 1. explicit auth_token, 2. INTERNAL_SERVICE_TOKEN
        self._auth_token = auth_token or settings.INTERNAL_SERVICE_TOKEN

    async def _post_model(self, path: str, payload: Any) -> dict[str, Any]:
        headers = {}
        if self._auth_token:
            headers["Authorization"] = f"Bearer {self._auth_token}"

        try:
            async with httpx.AsyncClient(timeout=self._timeout) as client:
                response = await client.post(
                    f"{self._base_url}{path}",
                    json=payload.model_dump(mode="json", exclude_none=True),
                    headers=headers,
                )
        except httpx.RequestError as exc:
            raise RemoteRagGatewayError(
                f"knowledge_runtime transport error: {exc}",
                code="remote_transport_error",
                retryable=True,
                details={"path": path},
            ) from exc

        if response.is_error:
            self._raise_remote_error(response)
        return response.json()

    @staticmethod
    def _raise_remote_error(response: httpx.Response) -> None:
        payload: dict[str, Any] | None = None
        try:
            raw_payload = response.json()
            if isinstance(raw_payload, dict):
                payload = raw_payload
        except ValueError:
            payload = None

        if payload is not None:
            try:
                remote_error = RemoteRagError.model_validate(payload)
            except ValidationError:
                remote_error = None
            else:
                raise RemoteRagGatewayError(
                    remote_error.message,
                    code=remote_error.code,
                    retryable=remote_error.retryable,
                    status_code=response.status_code,
                    details=remote_error.details,
                )

        raise RemoteRagGatewayError(
            response.text
            or f"knowledge_runtime request failed: {response.status_code}",
            status_code=response.status_code,
        )

    async def index_document(
        self,
        spec: IndexRuntimeSpec,
        *,
        db: Session | None = None,
    ) -> dict[str, Any]:
        """Index a document using reference mode.

        Args:
            spec: Index runtime spec with KB reference info.
            db: Database session (required for content ref resolution).

        Returns:
            Indexing result.
        """
        if db is None:
            raise ValueError("db is required for RemoteRagGateway.index_document")
        if spec.source.source_type != "attachment" or spec.source.attachment_id is None:
            raise ValueError("RemoteRagGateway only supports attachment sources")

        # Build KB reference - use index_owner_user_id for resolving config
        kb_reference = KnowledgeBaseReference(
            knowledge_base_id=spec.knowledge_base_id,
            user_id=spec.index_owner_user_id,
        )

        payload = RemoteIndexRequest(
            knowledge_base_id=spec.knowledge_base_id,
            document_id=spec.document_id,
            content_ref=build_content_ref_for_attachment(
                db=db,
                attachment_id=spec.source.attachment_id,
            ),
            knowledge_base_reference=kb_reference,
            splitter_config=spec.splitter_config,
            index_families=spec.index_families,
            user_name=spec.user_name,
        )
        return await self._post_model("/internal/rag/index", payload)

    async def query(
        self,
        spec: QueryRuntimeSpec,
        *,
        db: Session | None = None,
    ) -> dict[str, Any]:
        """Execute a RAG query using reference mode.

        Args:
            spec: Query runtime spec with KB references.
            db: Database session (not used, kept for interface consistency).

        Returns:
            Query result with records.
        """
        del db

        # Build KB references from knowledge_base_configs
        # Each KB config contains the index_owner_user_id needed for reference
        kb_references = [
            KnowledgeBaseReference(
                knowledge_base_id=kb_config.knowledge_base_id,
                user_id=kb_config.index_owner_user_id,
            )
            for kb_config in spec.knowledge_base_configs
        ]

        payload = RemoteQueryRequest(
            knowledge_base_ids=spec.knowledge_base_ids,
            query=spec.query,
            max_results=spec.max_results,
            knowledge_base_references=kb_references,
            user_id=spec.user_id or 0,
            document_ids=spec.document_ids,
            metadata_condition=spec.metadata_condition,
            user_name=spec.user_name,
            enabled_index_families=spec.enabled_index_families,
            retrieval_policy=spec.retrieval_policy,
        )
        response_payload = await self._post_model("/internal/rag/query", payload)
        response = RemoteQueryResponse.model_validate(response_payload)
        return {
            "mode": "rag_retrieval",
            **response.model_dump(),
        }

    async def delete_document_index(
        self,
        spec: DeleteRuntimeSpec,
        *,
        db: Session,
    ) -> dict[str, Any]:
        """Delete a document's index using reference mode.

        Args:
            spec: Delete runtime spec with KB reference.
            db: Database session (not used, kept for interface consistency).

        Returns:
            Deletion result.
        """
        del db

        # Build KB reference
        kb_reference = KnowledgeBaseReference(
            knowledge_base_id=spec.knowledge_base_id,
            user_id=spec.index_owner_user_id,
        )

        payload = RemoteDeleteDocumentIndexRequest(
            knowledge_base_id=spec.knowledge_base_id,
            document_ref=spec.document_ref,
            knowledge_base_reference=kb_reference,
            enabled_index_families=spec.enabled_index_families,
        )
        return await self._post_model("/internal/rag/delete-document-index", payload)

    async def purge_knowledge_index(
        self,
        spec: PurgeKnowledgeRuntimeSpec,
        *,
        db: Session,
    ) -> dict[str, Any]:
        """Purge all chunks for a knowledge base using reference mode.

        Args:
            spec: Purge runtime spec with KB reference.
            db: Database session (not used, kept for interface consistency).

        Returns:
            Purge result.
        """
        del db

        # Build KB reference
        kb_reference = KnowledgeBaseReference(
            knowledge_base_id=spec.knowledge_base_id,
            user_id=spec.index_owner_user_id,
        )

        payload = RemotePurgeKnowledgeIndexRequest(
            knowledge_base_id=spec.knowledge_base_id,
            knowledge_base_reference=kb_reference,
        )
        return await self._post_model("/internal/rag/purge-knowledge-index", payload)

    async def drop_knowledge_index(
        self,
        spec: DropKnowledgeIndexRuntimeSpec,
        *,
        db: Session,
    ) -> dict[str, Any]:
        """Drop the physical index for a knowledge base using reference mode.

        Args:
            spec: Drop runtime spec with KB reference.
            db: Database session (not used, kept for interface consistency).

        Returns:
            Drop result.
        """
        del db

        # Build KB reference
        kb_reference = KnowledgeBaseReference(
            knowledge_base_id=spec.knowledge_base_id,
            user_id=spec.index_owner_user_id,
        )

        payload = RemoteDropKnowledgeIndexRequest(
            knowledge_base_id=spec.knowledge_base_id,
            knowledge_base_reference=kb_reference,
        )
        return await self._post_model("/internal/rag/drop-knowledge-index", payload)

    async def list_chunks(
        self,
        spec: ListChunksRuntimeSpec,
        *,
        db: Session | None = None,
    ) -> dict[str, Any]:
        """List chunks for a knowledge base using reference mode.

        Args:
            spec: List chunks runtime spec with KB reference.
            db: Database session (not used, kept for interface consistency).

        Returns:
            List of chunks.
        """
        del db

        # Build KB reference
        kb_reference = KnowledgeBaseReference(
            knowledge_base_id=spec.knowledge_base_id,
            user_id=spec.index_owner_user_id,
        )

        payload = RemoteListChunksRequest(
            knowledge_base_id=spec.knowledge_base_id,
            knowledge_base_reference=kb_reference,
            max_chunks=spec.max_chunks,
            query=spec.query,
            metadata_condition=spec.metadata_condition,
        )
        response_payload = await self._post_model("/internal/rag/all-chunks", payload)
        response = RemoteListChunksResponse.model_validate(response_payload)
        return response.model_dump()

    async def test_connection(
        self,
        spec: ConnectionTestRuntimeSpec,
        *,
        db: Session | None = None,
    ) -> dict[str, Any]:
        """Test storage backend connection using reference mode.

        Args:
            spec: Connection test runtime spec with Retriever reference.
            db: Database session (not used, kept for interface consistency).

        Returns:
            Connection test result.
        """
        del db

        # Build Retriever reference
        retriever_reference = RetrieverReference(
            name=spec.retriever_name,
            namespace=spec.retriever_namespace,
            user_id=spec.user_id or 0,
        )

        payload = RemoteTestConnectionRequest(
            retriever_reference=retriever_reference,
        )
        return await self._post_model("/internal/rag/test-connection", payload)
