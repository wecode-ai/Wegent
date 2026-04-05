# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import logging

from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.subtask_context import ContextStatus, ContextType, SubtaskContext
from app.services.adapters.retriever_kinds import retriever_kinds_service
from app.services.context import context_service
from app.services.rag.embedding.factory import create_embedding_model_from_crd
from app.services.rag.runtime_specs import IndexRuntimeSpec
from app.services.rag.storage.factory import create_storage_backend
from knowledge_engine.services import DocumentService as EngineDocumentService
from shared.telemetry.decorators import trace_async

logger = logging.getLogger(__name__)


def _extract_index_document_attributes(
    spec: IndexRuntimeSpec,
    *,
    db: Session | None = None,
) -> dict[str, str | int]:
    return {
        "rag.knowledge_base_id": spec.knowledge_base_id,
        "rag.document_id": spec.document_id or 0,
        "rag.index_owner_user_id": spec.index_owner_user_id,
        "rag.retriever_name": spec.retriever_name,
        "rag.source_type": spec.source.source_type,
    }


def _extract_delete_document_attributes(
    knowledge_base_id: int,
    document_ref: str,
    *,
    db: Session,
    index_owner_user_id: int | None = None,
) -> dict[str, str | int]:
    return {
        "rag.knowledge_base_id": knowledge_base_id,
        "rag.document_ref": document_ref,
        "rag.index_owner_user_id": index_owner_user_id or 0,
    }


def _get_attachment_binary_source(
    db: Session,
    attachment_id: int,
) -> tuple[bytes, str, str]:
    context = (
        db.query(SubtaskContext)
        .filter(
            SubtaskContext.id == attachment_id,
            SubtaskContext.context_type == ContextType.ATTACHMENT.value,
        )
        .first()
    )
    if not context:
        raise ValueError(f"Attachment context {attachment_id} not found")
    if context.status != ContextStatus.READY.value:
        raise ValueError(
            f"Attachment context {attachment_id} is not ready (status: {context.status})"
        )

    binary_data = context_service.get_attachment_binary_data(
        db=db,
        context=context,
    )
    if binary_data is None:
        raise ValueError(
            f"Attachment context {attachment_id} has no binary data available"
        )

    return binary_data, context.original_filename, context.file_extension


@trace_async(
    span_name="rag.index_document_local",
    tracer_name="backend.services.rag",
    extract_attributes=_extract_index_document_attributes,
)
async def index_document_local(
    spec: IndexRuntimeSpec,
    *,
    db: Session | None = None,
) -> dict:
    if db is None:
        raise ValueError("db is required for local indexing execution")

    retriever = retriever_kinds_service.get_retriever(
        db=db,
        user_id=spec.index_owner_user_id,
        name=spec.retriever_name,
        namespace=spec.retriever_namespace,
    )
    if retriever is None:
        logger.warning(
            "Retriever %s not found for KB %s during indexing",
            spec.retriever_name,
            spec.knowledge_base_id,
        )
        return {
            "status": "skipped",
            "reason": "retriever_not_found",
            "knowledge_id": str(spec.knowledge_base_id),
            "document_id": spec.document_id,
        }

    storage_backend = create_storage_backend(retriever)
    embed_model = create_embedding_model_from_crd(
        db=db,
        user_id=spec.index_owner_user_id,
        model_name=spec.embedding_model_name,
        model_namespace=spec.embedding_model_namespace,
        user_name=spec.user_name,
    )
    service = EngineDocumentService(storage_backend=storage_backend)

    if spec.source.source_type == "attachment":
        binary_data, source_file, file_extension = _get_attachment_binary_source(
            db,
            spec.source.attachment_id,
        )
        return await service.index_document_from_binary(
            knowledge_id=str(spec.knowledge_base_id),
            binary_data=binary_data,
            source_file=source_file,
            file_extension=file_extension,
            embed_model=embed_model,
            user_id=spec.index_owner_user_id,
            splitter_config=spec.splitter_config,
            document_id=spec.document_id,
        )

    return await service.index_document_from_file(
        knowledge_id=str(spec.knowledge_base_id),
        file_path=spec.source.file_path,
        embed_model=embed_model,
        user_id=spec.index_owner_user_id,
        splitter_config=spec.splitter_config,
        document_id=spec.document_id,
    )


@trace_async(
    span_name="rag.delete_document_index_local",
    tracer_name="backend.services.rag",
    extract_attributes=_extract_delete_document_attributes,
)
async def delete_document_index_local(
    knowledge_base_id: int,
    document_ref: str,
    *,
    db: Session,
    index_owner_user_id: int | None = None,
) -> dict:
    """Delete document chunks from the local storage backend."""
    kb = (
        db.query(Kind)
        .filter(
            Kind.id == knowledge_base_id,
            Kind.kind == "KnowledgeBase",
            Kind.is_active,
        )
        .first()
    )
    if kb is None:
        return {
            "status": "skipped",
            "reason": "knowledge_base_not_found",
            "knowledge_id": str(knowledge_base_id),
            "doc_ref": document_ref,
        }

    retrieval_config = (kb.json or {}).get("spec", {}).get("retrievalConfig") or {}
    retriever_name = retrieval_config.get("retriever_name")
    retriever_namespace = retrieval_config.get("retriever_namespace", "default")
    if not retriever_name:
        return {
            "status": "skipped",
            "reason": "missing_retriever_name",
            "knowledge_id": str(knowledge_base_id),
            "doc_ref": document_ref,
        }

    runtime_user_id = index_owner_user_id or kb.user_id
    retriever = retriever_kinds_service.get_retriever(
        db=db,
        user_id=runtime_user_id,
        name=retriever_name,
        namespace=retriever_namespace,
    )
    if retriever is None:
        logger.warning(
            "Retriever %s not found for KB %s during delete-index cleanup",
            retriever_name,
            knowledge_base_id,
        )
        return {
            "status": "skipped",
            "reason": "retriever_not_found",
            "knowledge_id": str(knowledge_base_id),
            "doc_ref": document_ref,
        }

    storage_backend = create_storage_backend(retriever)
    service = EngineDocumentService(storage_backend=storage_backend)
    return await service.delete_document(
        knowledge_id=str(knowledge_base_id),
        doc_ref=document_ref,
        user_id=runtime_user_id,
    )
