# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

from typing import Any

import httpx
from pydantic import ValidationError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.payload_codec import (
    decode_sync_response_json,
    decode_sync_response_text,
    encode_http_json,
    run_payload_codec,
)
from app.db.session import SessionLocal
from app.models.subtask_context import ContextType
from app.services.context import context_service
from app.services.rag.content_refs import build_content_ref_for_attachment
from app.services.rag.runtime_specs import (
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


def _dump_remote_request(payload: Any) -> dict[str, Any]:
    return payload.model_dump(mode="json", exclude_none=True)


def _build_remote_query_request(spec: QueryRuntimeSpec) -> RemoteQueryRequest:
    return RemoteQueryRequest(
        knowledge_base_ids=spec.knowledge_base_ids,
        user_id=spec.user_id or 0,
        query=spec.query,
        search_hints=spec.search_hints,
        max_results=spec.max_results,
        knowledge_base_retrieval_overrides=(
            spec.knowledge_base_retrieval_overrides or None
        ),
        scope=spec.scope,
        metadata_condition=spec.metadata_condition,
    )


def _decode_remote_query_response(payload: dict[str, Any]) -> dict[str, Any]:
    response = RemoteQueryResponse.model_validate(payload)
    return {"mode": "rag_retrieval", **response.model_dump()}


def _decode_remote_chunk_response(payload: dict[str, Any]) -> dict[str, Any]:
    return RemoteListChunksResponse.model_validate(payload).model_dump()


def _build_remote_delete_request(
    spec: DeleteRuntimeSpec,
) -> RemoteDeleteDocumentIndexRequest:
    return RemoteDeleteDocumentIndexRequest(
        knowledge_base_id=spec.knowledge_base_id,
        user_id=spec.index_owner_user_id,
        document_ref=spec.document_ref,
    )


def _build_remote_purge_request(
    spec: PurgeKnowledgeRuntimeSpec,
) -> RemotePurgeKnowledgeIndexRequest:
    return RemotePurgeKnowledgeIndexRequest(
        knowledge_base_id=spec.knowledge_base_id,
        user_id=spec.index_owner_user_id,
    )


def _build_remote_drop_request(
    spec: DropKnowledgeIndexRuntimeSpec,
) -> RemoteDropKnowledgeIndexRequest:
    return RemoteDropKnowledgeIndexRequest(
        knowledge_base_id=spec.knowledge_base_id,
        user_id=spec.index_owner_user_id,
    )


def _build_remote_list_request(spec: ListChunksRuntimeSpec) -> RemoteListChunksRequest:
    return RemoteListChunksRequest(
        knowledge_base_id=spec.knowledge_base_id,
        user_id=spec.index_owner_user_id,
        max_chunks=spec.max_chunks,
        query=spec.query,
        metadata_condition=spec.metadata_condition,
    )


def _validate_remote_error(payload: dict[str, Any]) -> RemoteRagError | None:
    try:
        return RemoteRagError.model_validate(payload)
    except ValidationError:
        return None


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
        headers = {"Content-Type": "application/json"}
        if self._auth_token:
            headers["Authorization"] = f"Bearer {self._auth_token}"

        json_payload = await run_payload_codec(
            _dump_remote_request,
            payload,
            payload_hint=payload,
            force_offload=True,
        )
        body = await encode_http_json(json_payload)
        try:
            async with httpx.AsyncClient(timeout=self._timeout) as client:
                response = await client.post(
                    f"{self._base_url}{path}",
                    content=body,
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
            await self._raise_remote_error(response)
        return await decode_sync_response_json(response)

    @staticmethod
    async def _raise_remote_error(response: httpx.Response) -> None:
        payload: dict[str, Any] | None = None
        try:
            raw_payload = await decode_sync_response_json(response)
            if isinstance(raw_payload, dict):
                payload = raw_payload
        except ValueError:
            payload = None

        if payload is not None:
            remote_error = await run_payload_codec(
                _validate_remote_error,
                payload,
                payload_hint=payload,
                force_offload=True,
            )
            if remote_error is not None:
                raise RemoteRagGatewayError(
                    remote_error.message,
                    code=remote_error.code,
                    retryable=remote_error.retryable,
                    status_code=response.status_code,
                    details=remote_error.details,
                )

        message = await decode_sync_response_text(response) or (
            f"knowledge_runtime request failed: {response.status_code}"
        )
        raise RemoteRagGatewayError(message, status_code=response.status_code)

    async def index_document(
        self,
        spec: IndexRuntimeSpec,
        *,
        db: Session | None = None,
    ) -> dict[str, Any]:
        if spec.source.source_type != "attachment" or spec.source.attachment_id is None:
            raise ValueError("RemoteRagGateway only supports attachment sources")

        payload = _build_remote_index_request(spec, db=db)
        return await self._post_model("/internal/rag/index", payload)

    async def query(
        self,
        spec: QueryRuntimeSpec,
    ) -> dict[str, Any]:
        payload = await run_payload_codec(
            _build_remote_query_request,
            spec,
            payload_hint=spec,
            force_offload=True,
        )
        response_payload = await self._post_model("/internal/rag/query", payload)
        return await run_payload_codec(
            _decode_remote_query_response,
            response_payload,
            payload_hint=response_payload,
            force_offload=True,
        )

    async def delete_document_index(
        self,
        spec: DeleteRuntimeSpec,
        *,
        db: Session | None = None,
    ) -> dict[str, Any]:
        del db
        payload = await run_payload_codec(
            _build_remote_delete_request,
            spec,
            payload_hint=spec,
            force_offload=True,
        )
        return await self._post_model("/internal/rag/delete-document-index", payload)

    async def purge_knowledge_index(
        self,
        spec: PurgeKnowledgeRuntimeSpec,
        *,
        db: Session | None = None,
    ) -> dict[str, Any]:
        del db
        payload = await run_payload_codec(
            _build_remote_purge_request,
            spec,
            payload_hint=spec,
            force_offload=True,
        )
        return await self._post_model("/internal/rag/purge-knowledge-index", payload)

    async def drop_knowledge_index(
        self,
        spec: DropKnowledgeIndexRuntimeSpec,
        *,
        db: Session | None = None,
    ) -> dict[str, Any]:
        del db
        payload = await run_payload_codec(
            _build_remote_drop_request,
            spec,
            payload_hint=spec,
            force_offload=True,
        )
        return await self._post_model("/internal/rag/drop-knowledge-index", payload)

    async def list_chunks(
        self,
        spec: ListChunksRuntimeSpec,
        *,
        db: Session | None = None,
    ) -> dict[str, Any]:
        del db
        payload = await run_payload_codec(
            _build_remote_list_request,
            spec,
            payload_hint=spec,
            force_offload=True,
        )
        response_payload = await self._post_model("/internal/rag/all-chunks", payload)
        return await run_payload_codec(
            _decode_remote_chunk_response,
            response_payload,
            payload_hint=response_payload,
            force_offload=True,
        )


def _build_remote_index_request(
    spec: IndexRuntimeSpec,
    *,
    db: Session | None,
) -> RemoteIndexRequest:
    own_session = db is None
    if own_session:
        db = SessionLocal()
    try:
        source_file, file_extension = _get_attachment_source_metadata(
            db=db,
            attachment_id=spec.source.attachment_id,
        )
        return RemoteIndexRequest(
            knowledge_base_id=spec.knowledge_base_id,
            user_id=spec.index_owner_user_id,
            document_id=spec.document_id,
            source_file=source_file,
            file_extension=file_extension,
            content_ref=build_content_ref_for_attachment(
                db=db,
                attachment_id=spec.source.attachment_id,
            ),
        )
    finally:
        if own_session:
            db.rollback()
            db.close()


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
