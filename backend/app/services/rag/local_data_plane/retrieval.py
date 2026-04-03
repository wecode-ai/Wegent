# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from sqlalchemy.orm import Session

from app.services.rag.retrieval_service import RetrievalService
from app.services.rag.runtime_specs import (
    DEFAULT_DIRECT_INJECTION_BUDGET,
    QueryRuntimeSpec,
)
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
