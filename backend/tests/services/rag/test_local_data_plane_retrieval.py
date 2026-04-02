# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.rag.local_data_plane.retrieval import query_local
from app.services.rag.runtime_specs import (
    DEFAULT_DIRECT_INJECTION_BUDGET,
    QueryRuntimeSpec,
)


@pytest.mark.asyncio
async def test_query_local_uses_shared_default_budget() -> None:
    spec = QueryRuntimeSpec(knowledge_base_ids=[1], query="release checklist")
    db = MagicMock()

    with patch(
        "app.services.rag.local_data_plane.retrieval.RetrievalService.retrieve_for_chat_shell",
        new_callable=AsyncMock,
        return_value={"mode": "rag_retrieval", "records": [], "total": 0},
    ) as mock_retrieve:
        result = await query_local(spec, db=db)

    assert result["mode"] == "rag_retrieval"
    mock_retrieve.assert_awaited_once_with(
        query="release checklist",
        knowledge_base_ids=[1],
        db=db,
        max_results=5,
        document_ids=None,
        user_name=None,
        route_mode="auto",
        user_id=None,
        context_window=DEFAULT_DIRECT_INJECTION_BUDGET.context_window,
        used_context_tokens=DEFAULT_DIRECT_INJECTION_BUDGET.used_context_tokens,
        reserved_output_tokens=DEFAULT_DIRECT_INJECTION_BUDGET.reserved_output_tokens,
        context_buffer_ratio=DEFAULT_DIRECT_INJECTION_BUDGET.context_buffer_ratio,
        max_direct_chunks=DEFAULT_DIRECT_INJECTION_BUDGET.max_direct_chunks,
        restricted_mode=False,
    )
