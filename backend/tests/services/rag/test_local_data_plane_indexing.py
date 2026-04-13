# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.rag.local_data_plane.indexing import (
    delete_document_index_local,
    index_document_local,
)
from app.services.rag.runtime_specs import (
    DeleteRuntimeSpec,
    IndexRuntimeSpec,
    IndexSource,
)
from shared.models import RuntimeRetrieverConfig


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
            "app.services.rag.local_data_plane.indexing.create_storage_backend_from_runtime_config"
        ) as mock_create_storage_backend,
        patch(
            "app.services.rag.local_data_plane.indexing.EngineDocumentService.index_document_from_binary",
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


@pytest.mark.asyncio
async def test_index_document_local_delegates_to_engine_document_service() -> None:
    spec = IndexRuntimeSpec(
        knowledge_base_id=1,
        document_id=2,
        index_owner_user_id=3,
        retriever_name="retriever-a",
        retriever_namespace="default",
        embedding_model_name="embed-a",
        embedding_model_namespace="default",
        source=IndexSource(source_type="attachment", attachment_id=9),
        splitter_config={"type": "sentence", "chunk_size": 256, "chunk_overlap": 32},
        user_name="tester",
    )
    storage_backend = MagicMock()
    embed_model = object()
    retriever = SimpleNamespace(
        metadata=SimpleNamespace(name="retriever-a", namespace="default"),
        spec=SimpleNamespace(
            storageConfig=SimpleNamespace(
                type="qdrant",
                url="http://qdrant:6333",
                username=None,
                password=None,
                apiKey=None,
                indexStrategy=SimpleNamespace(
                    model_dump=lambda exclude_none=True: {"mode": "per_dataset"}
                ),
                ext={},
            )
        ),
    )

    with (
        patch(
            "app.services.rag.local_data_plane.indexing.retriever_kinds_service.get_retriever",
            return_value=retriever,
        ),
        patch(
            "app.services.rag.local_data_plane.indexing.create_storage_backend_from_runtime_config",
            return_value=storage_backend,
        ),
        patch(
            "app.services.rag.local_data_plane.indexing.create_embedding_model_from_crd",
            return_value=embed_model,
        ),
        patch(
            "app.services.rag.local_data_plane.indexing._get_attachment_binary_source",
            return_value=(b"hello world", "report.pdf", ".pdf"),
        ),
        patch(
            "app.services.rag.local_data_plane.indexing.EngineDocumentService.index_document_from_binary",
            new_callable=AsyncMock,
            return_value={
                "status": "success",
                "knowledge_id": "1",
                "doc_ref": "2",
                "indexed_count": 1,
                "index_name": "wegent_kb_1",
                "chunk_count": 1,
                "source_file": "report.pdf",
                "created_at": "2026-04-05T00:00:00+00:00",
                "chunks_data": [{"chunk_index": 0}],
            },
        ) as mock_index_document,
    ):
        result = await index_document_local(spec, db=MagicMock())

    assert result["status"] == "success"
    mock_index_document.assert_awaited_once_with(
        knowledge_id="1",
        binary_data=b"hello world",
        source_file="report.pdf",
        file_extension=".pdf",
        embed_model=embed_model,
        user_id=3,
        splitter_config={"type": "sentence", "chunk_size": 256, "chunk_overlap": 32},
        document_id=2,
    )


@pytest.mark.asyncio
async def test_delete_document_index_local_delegates_to_engine_document_service() -> (
    None
):
    spec = DeleteRuntimeSpec(
        knowledge_base_id=1,
        document_ref="doc-1",
        index_owner_user_id=7,
        retriever_config=RuntimeRetrieverConfig(
            name="retriever-a",
            namespace="default",
            storage_config={"type": "qdrant"},
        ),
    )

    with (
        patch(
            "app.services.rag.local_data_plane.indexing.create_storage_backend_from_runtime_config",
            return_value=MagicMock(),
        ),
        patch(
            "app.services.rag.local_data_plane.indexing.EngineDocumentService.delete_document",
            new_callable=AsyncMock,
            return_value={"status": "success", "deleted_chunks": 4},
        ) as mock_delete_document,
    ):
        result = await delete_document_index_local(spec, db=MagicMock())

    assert result == {"status": "success", "deleted_chunks": 4}
    mock_delete_document.assert_awaited_once_with(
        knowledge_id="1",
        doc_ref="doc-1",
        user_id=7,
    )


@pytest.mark.asyncio
async def test_delete_document_index_local_rejects_unsupported_index_families() -> None:
    spec = DeleteRuntimeSpec(
        knowledge_base_id=1,
        document_ref="doc-1",
        index_owner_user_id=7,
        retriever_config=RuntimeRetrieverConfig(
            name="retriever-a",
            namespace="default",
            storage_config={"type": "qdrant"},
        ),
        enabled_index_families=["chunk_vector", "summary_vector_index"],
    )

    with patch(
        "app.services.rag.local_data_plane.indexing.EngineDocumentService.delete_document",
        new_callable=AsyncMock,
    ) as mock_delete_document:
        with pytest.raises(ValueError, match="Local delete only supports chunk_vector"):
            await delete_document_index_local(spec, db=MagicMock())

    mock_delete_document.assert_not_awaited()
