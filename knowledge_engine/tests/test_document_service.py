# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import MagicMock, patch

import pytest


@pytest.mark.asyncio
async def test_index_document_from_binary_delegates_to_indexer() -> None:
    from knowledge_engine.services.document_service import DocumentService

    storage_backend = MagicMock()
    embed_model = object()
    indexer = MagicMock()
    indexer.index_from_binary.return_value = {
        "indexed_count": 2,
        "index_name": "wegent_kb_1",
        "status": "success",
        "chunks_data": [{"chunk_index": 0}, {"chunk_index": 1}],
    }

    service = DocumentService(storage_backend=storage_backend)

    with patch(
        "knowledge_engine.services.document_service.DocumentIndexer",
        return_value=indexer,
    ):
        result = await service.index_document_from_binary(
            knowledge_id="1",
            binary_data=b"hello world",
            source_file="report.pdf",
            file_extension=".pdf",
            embed_model=embed_model,
            user_id=7,
            splitter_config={
                "type": "sentence",
                "chunk_size": 256,
                "chunk_overlap": 32,
            },
            document_id=9,
        )

    assert result == {
        "doc_ref": "9",
        "knowledge_id": "1",
        "source_file": "report.pdf",
        "chunk_count": 2,
        "index_name": "wegent_kb_1",
        "status": "success",
        "created_at": result["created_at"],
        "chunks_data": [{"chunk_index": 0}, {"chunk_index": 1}],
        "indexed_count": 2,
    }
    indexer.index_from_binary.assert_called_once()
    call_kwargs = indexer.index_from_binary.call_args.kwargs
    chunk_metadata = call_kwargs["chunk_metadata"]
    assert chunk_metadata.knowledge_id == "1"
    assert chunk_metadata.doc_ref == "9"
    assert chunk_metadata.source_file == "report.pdf"
    assert call_kwargs["binary_data"] == b"hello world"
    assert call_kwargs["file_extension"] == ".pdf"
    assert call_kwargs["user_id"] == 7


@pytest.mark.asyncio
async def test_delete_document_delegates_to_storage_backend() -> None:
    from knowledge_engine.services.document_service import DocumentService

    storage_backend = MagicMock()
    storage_backend.delete_document.return_value = {
        "doc_ref": "doc-1",
        "knowledge_id": "1",
        "deleted_chunks": 3,
        "status": "success",
    }
    service = DocumentService(storage_backend=storage_backend)

    result = await service.delete_document(
        knowledge_id="1",
        doc_ref="doc-1",
        user_id=5,
    )

    assert result == {
        "doc_ref": "doc-1",
        "knowledge_id": "1",
        "deleted_chunks": 3,
        "status": "success",
    }
    storage_backend.delete_document.assert_called_once_with(
        knowledge_id="1",
        doc_ref="doc-1",
        user_id=5,
    )
