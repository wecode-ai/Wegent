# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.rag.local_data_plane.indexing import index_document_local
from app.services.rag.runtime_specs import IndexRuntimeSpec, IndexSource


@pytest.mark.asyncio
async def test_index_document_local_skips_missing_retriever() -> None:
    spec = IndexRuntimeSpec(
        knowledge_base_id=1,
        document_id=2,
        index_owner_user_id=3,
        retriever_name="missing-retriever",
        retriever_namespace="default",
        embedding_model_name="embed-a",
        embedding_model_namespace="default",
        source=IndexSource(source_type="attachment", attachment_id=9),
    )

    with (
        patch(
            "app.services.rag.local_data_plane.indexing.retriever_kinds_service.get_retriever",
            return_value=None,
        ) as mock_get_retriever,
        patch(
            "app.services.rag.local_data_plane.indexing.create_storage_backend"
        ) as mock_create_storage_backend,
        patch(
            "app.services.rag.local_data_plane.indexing.DocumentService.index_document",
            new_callable=AsyncMock,
        ) as mock_index_document,
    ):
        result = await index_document_local(spec, db=MagicMock())

    assert result == {
        "status": "skipped",
        "reason": "retriever_not_found",
        "knowledge_id": "1",
        "document_id": 2,
    }
    mock_get_retriever.assert_called_once()
    mock_create_storage_backend.assert_not_called()
    mock_index_document.assert_not_awaited()
