# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

from typing import Any

import httpx
from pydantic import ValidationError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.subtask_context import ContextType
from app.services.context import context_service
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
        if db is None:
            raise ValueError("db is required for RemoteRagGateway.index_document")
        if spec.source.source_type != "attachment" or spec.source.attachment_id is None:
            raise ValueError("RemoteRagGateway only supports attachment sources")

        source_file, file_extension = _get_attachment_source_metadata(
            db=db,
            attachment_id=spec.source.attachment_id,
        )
        payload = RemoteIndexRequest(
            knowledge_base_id=spec.knowledge_base_id,
            document_id=spec.document_id,
            index_owner_user_id=spec.index_owner_user_id,
            retriever_config=spec.retriever_config
            or {
                "name": spec.retriever_name,
                "namespace": spec.retriever_namespace,
            },
            embedding_model_config=spec.embedding_model_config
            or {
                "model_name": spec.embedding_model_name,
                "model_namespace": spec.embedding_model_namespace,
            },
            splitter_config=spec.splitter_config,
            index_families=spec.index_families,
            content_ref=build_content_ref_for_attachment(
                db=db,
                attachment_id=spec.source.attachment_id,
            ),
            source_file=source_file,
            file_extension=file_extension,
            user_name=spec.user_name,
        )
        return await self._post_model("/internal/rag/index", payload)

    async def query(
        self,
        spec: QueryRuntimeSpec,
        *,
        db: Session | None = None,
    ) -> dict[str, Any]:
        del db
        payload = RemoteQueryRequest(
            knowledge_base_ids=spec.knowledge_base_ids,
            query=spec.query,
            max_results=spec.max_results,
            document_ids=spec.document_ids,
            metadata_condition=spec.metadata_condition,
            user_name=spec.user_name,
            knowledge_base_configs=spec.knowledge_base_configs,
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
        del db
        payload = RemoteDeleteDocumentIndexRequest(
            knowledge_base_id=spec.knowledge_base_id,
            document_ref=spec.document_ref,
            index_owner_user_id=spec.index_owner_user_id,
            retriever_config=spec.retriever_config,
            enabled_index_families=spec.enabled_index_families,
        )
        return await self._post_model("/internal/rag/delete-document-index", payload)

    async def purge_knowledge_index(
        self,
        spec: PurgeKnowledgeRuntimeSpec,
        *,
        db: Session,
    ) -> dict[str, Any]:
        del db
        payload = RemotePurgeKnowledgeIndexRequest(
            knowledge_base_id=spec.knowledge_base_id,
            index_owner_user_id=spec.index_owner_user_id,
            retriever_config=spec.retriever_config,
        )
        return await self._post_model("/internal/rag/purge-knowledge-index", payload)

    async def drop_knowledge_index(
        self,
        spec: DropKnowledgeIndexRuntimeSpec,
        *,
        db: Session,
    ) -> dict[str, Any]:
        del db
        payload = RemoteDropKnowledgeIndexRequest(
            knowledge_base_id=spec.knowledge_base_id,
            index_owner_user_id=spec.index_owner_user_id,
            retriever_config=spec.retriever_config,
        )
        return await self._post_model("/internal/rag/drop-knowledge-index", payload)

    async def list_chunks(
        self,
        spec: ListChunksRuntimeSpec,
        *,
        db: Session | None = None,
    ) -> dict[str, Any]:
        del db
        payload = RemoteListChunksRequest(
            knowledge_base_id=spec.knowledge_base_id,
            index_owner_user_id=spec.index_owner_user_id,
            retriever_config=spec.retriever_config,
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
        del db
        payload = RemoteTestConnectionRequest(retriever_config=spec.retriever_config)
        return await self._post_model("/internal/rag/test-connection", payload)


def _get_attachment_source_metadata(
    *,
    db: Session,
    attachment_id: int,
) -> tuple[str | None, str | None]:
    context = context_service.get_context_optional(
        db=db,
        context_id=attachment_id,
    )
    if context is None or context.context_type != ContextType.ATTACHMENT.value:
        return None, None

    return context.original_filename or None, context.file_extension or None
