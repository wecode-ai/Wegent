# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import asyncio

from sqlalchemy.orm import Session

from app.services.rag.retrieval_service import RetrievalService
from app.services.rag.runtime_specs import (
    DEFAULT_DIRECT_INJECTION_BUDGET,
    ListChunksRuntimeSpec,
    QueryRuntimeSpec,
)
from knowledge_engine.storage.factory import create_storage_backend_from_runtime_config
from shared.telemetry.decorators import trace_async


def _extract_query_local_attributes(
    spec: QueryRuntimeSpec,
    *,
    db: Session,
) -> dict[str, str | int | bool]:
    return {
        "rag.kb_count": len(spec.knowledge_base_ids),
        "rag.route_mode": spec.route_mode,
        "rag.max_results": spec.max_results,
        "rag.document_filter_count": len(spec.document_ids or []),
        "rag.restricted_mode": spec.restricted_mode,
        "rag.user_id": spec.user_id or 0,
    }


@trace_async(
    span_name="rag.query_local",
    tracer_name="backend.services.rag",
    extract_attributes=_extract_query_local_attributes,
)
async def query_local(
    spec: QueryRuntimeSpec,
    *,
    db: Session,
) -> dict:
    service = RetrievalService()
    budget = spec.direct_injection_budget or DEFAULT_DIRECT_INJECTION_BUDGET
    return await service.retrieve_for_chat_shell(
        query=spec.query,
        knowledge_base_ids=spec.knowledge_base_ids,
        db=db,
        max_results=spec.max_results,
        document_ids=spec.document_ids,
        metadata_condition=spec.metadata_condition,
        knowledge_base_configs=spec.knowledge_base_configs,
        user_name=spec.user_name,
        route_mode=spec.route_mode,
        user_id=spec.user_id,
        context_window=budget.context_window,
        used_context_tokens=budget.used_context_tokens,
        reserved_output_tokens=budget.reserved_output_tokens,
        context_buffer_ratio=budget.context_buffer_ratio,
        max_direct_chunks=budget.max_direct_chunks,
        restricted_mode=spec.restricted_mode,
    )


def _extract_list_chunks_local_attributes(
    spec: ListChunksRuntimeSpec,
    *,
    db: Session,
) -> dict[str, str | int]:
    del db
    return {
        "rag.knowledge_base_id": spec.knowledge_base_id,
        "rag.max_chunks": spec.max_chunks,
        "rag.index_owner_user_id": spec.index_owner_user_id,
    }


@trace_async(
    span_name="rag.list_chunks_local",
    tracer_name="backend.services.rag",
    extract_attributes=_extract_list_chunks_local_attributes,
)
async def list_chunks_local(
    spec: ListChunksRuntimeSpec,
    *,
    db: Session,
) -> dict:
    del db
    storage_backend = create_storage_backend_from_runtime_config(spec.retriever_config)
    chunks = await asyncio.to_thread(
        storage_backend.get_all_chunks,
        knowledge_id=str(spec.knowledge_base_id),
        max_chunks=spec.max_chunks,
        user_id=spec.index_owner_user_id,
        metadata_condition=spec.metadata_condition,
    )
    return {
        "chunks": chunks,
        "total": len(chunks),
    }
