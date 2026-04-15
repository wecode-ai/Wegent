# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import asyncio
import logging

from sqlalchemy.orm import Session

from app.models.subtask_context import ContextStatus, ContextType, SubtaskContext
from app.services.adapters.retriever_kinds import retriever_kinds_service
from app.services.context import context_service
from app.services.rag.embedding.factory import (
    create_embedding_model_from_crd,
    create_embedding_model_from_runtime_config,
)
from app.services.rag.runtime_specs import (
    DeleteRuntimeSpec,
    DropKnowledgeIndexRuntimeSpec,
    IndexRuntimeSpec,
    PurgeKnowledgeRuntimeSpec,
)
from knowledge_engine.services import DocumentService as EngineDocumentService
from knowledge_engine.storage.factory import create_storage_backend_from_runtime_config
from shared.models import RuntimeRetrieverConfig, serialize_splitter_config
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
    spec: DeleteRuntimeSpec,
    *,
    db: Session,
) -> dict[str, str | int]:
    return {
        "rag.knowledge_base_id": spec.knowledge_base_id,
        "rag.document_ref": spec.document_ref,
        "rag.index_owner_user_id": spec.index_owner_user_id,
    }


def _extract_knowledge_index_attributes(
    spec: PurgeKnowledgeRuntimeSpec | DropKnowledgeIndexRuntimeSpec,
    *,
    db: Session | None = None,
) -> dict[str, str | int]:
    return {
        "rag.knowledge_base_id": spec.knowledge_base_id,
        "rag.index_owner_user_id": spec.index_owner_user_id,
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

    try:
        storage_backend = _build_index_storage_backend(spec, db=db)
    except ValueError as exc:
        if str(exc) != "retriever_not_found":
            raise
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

    embed_model = _build_index_embed_model(spec, db=db)
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
            splitter_config=serialize_splitter_config(spec.splitter_config),
            document_id=spec.document_id,
        )

    raise ValueError(
        f"Unsupported index source type for local execution: {spec.source.source_type}"
    )


@trace_async(
    span_name="rag.delete_document_index_local",
    tracer_name="backend.services.rag",
    extract_attributes=_extract_delete_document_attributes,
)
async def delete_document_index_local(
    spec: DeleteRuntimeSpec,
    *,
    db: Session,
) -> dict:
    """Delete document chunks from the local storage backend."""
    del db
    unsupported_families = [
        family for family in spec.enabled_index_families if family != "chunk_vector"
    ]
    if unsupported_families:
        raise ValueError(
            "Local delete only supports chunk_vector index family; "
            f"unsupported: {', '.join(sorted(set(unsupported_families)))}"
        )

    storage_backend = create_storage_backend_from_runtime_config(spec.retriever_config)
    service = EngineDocumentService(storage_backend=storage_backend)
    return await service.delete_document(
        knowledge_id=str(spec.knowledge_base_id),
        doc_ref=spec.document_ref,
        user_id=spec.index_owner_user_id,
    )


@trace_async(
    span_name="rag.purge_knowledge_index_local",
    tracer_name="backend.services.rag",
    extract_attributes=_extract_knowledge_index_attributes,
)
async def purge_knowledge_index_local(
    spec: PurgeKnowledgeRuntimeSpec,
    *,
    db: Session,
) -> dict:
    del db
    storage_backend = create_storage_backend_from_runtime_config(spec.retriever_config)
    return await asyncio.to_thread(
        storage_backend.delete_knowledge,
        knowledge_id=str(spec.knowledge_base_id),
        user_id=spec.index_owner_user_id,
    )


@trace_async(
    span_name="rag.drop_knowledge_index_local",
    tracer_name="backend.services.rag",
    extract_attributes=_extract_knowledge_index_attributes,
)
async def drop_knowledge_index_local(
    spec: DropKnowledgeIndexRuntimeSpec,
    *,
    db: Session,
) -> dict:
    del db
    storage_backend = create_storage_backend_from_runtime_config(spec.retriever_config)
    return await asyncio.to_thread(
        storage_backend.drop_knowledge_index,
        knowledge_id=str(spec.knowledge_base_id),
        user_id=spec.index_owner_user_id,
    )


def _build_index_storage_backend(
    spec: IndexRuntimeSpec,
    *,
    db: Session,
):
    if spec.retriever_config is not None:
        return create_storage_backend_from_runtime_config(spec.retriever_config)

    retriever = retriever_kinds_service.get_retriever(
        db=db,
        user_id=spec.index_owner_user_id,
        name=spec.retriever_name,
        namespace=spec.retriever_namespace,
    )
    if retriever is None:
        raise ValueError("retriever_not_found")
    return create_storage_backend_from_runtime_config(
        _build_runtime_retriever_config(retriever)
    )


def _build_runtime_retriever_config(retriever) -> RuntimeRetrieverConfig:
    storage_config = retriever.spec.storageConfig
    return RuntimeRetrieverConfig(
        name=retriever.metadata.name,
        namespace=retriever.metadata.namespace,
        storage_config={
            "type": storage_config.type.lower(),
            "url": storage_config.url,
            "username": storage_config.username,
            "password": storage_config.password,
            "apiKey": storage_config.apiKey,
            "indexStrategy": (
                storage_config.indexStrategy.model_dump(exclude_none=True)
                if storage_config.indexStrategy is not None
                else {"mode": "per_dataset"}
            ),
            "ext": storage_config.ext or {},
        },
    )


def _build_index_embed_model(
    spec: IndexRuntimeSpec,
    *,
    db: Session,
):
    if spec.embedding_model_config is not None:
        return create_embedding_model_from_runtime_config(spec.embedding_model_config)

    return create_embedding_model_from_crd(
        db=db,
        user_id=spec.index_owner_user_id,
        model_name=spec.embedding_model_name,
        model_namespace=spec.embedding_model_namespace,
        user_name=spec.user_name,
    )
