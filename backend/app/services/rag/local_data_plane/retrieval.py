# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from sqlalchemy.orm import Session

from app.services.rag.retrieval_service import RetrievalService
from app.services.rag.runtime_specs import QueryRuntimeSpec


async def query_local(
    spec: QueryRuntimeSpec,
    *,
    db: Session,
) -> dict:
    service = RetrievalService()
    budget = spec.direct_injection_budget
    return await service.retrieve_for_chat_shell(
        query=spec.query,
        knowledge_base_ids=spec.knowledge_base_ids,
        db=db,
        max_results=spec.max_results,
        document_ids=spec.document_ids,
        user_name=spec.user_name,
        route_mode=spec.route_mode,
        user_id=spec.user_id,
        context_window=budget.context_window if budget else None,
        used_context_tokens=budget.used_context_tokens if budget else 0,
        reserved_output_tokens=budget.reserved_output_tokens if budget else 4096,
        context_buffer_ratio=budget.context_buffer_ratio if budget else 0.1,
        max_direct_chunks=budget.max_direct_chunks if budget else 500,
        restricted_mode=spec.restricted_mode,
    )
