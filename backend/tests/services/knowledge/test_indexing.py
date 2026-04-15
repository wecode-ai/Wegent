# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from app.services.knowledge.indexing import run_document_indexing


def test_run_document_indexing_propagates_gateway_skip_status() -> None:
    db = MagicMock()
    db.query.return_value.filter.return_value.first.return_value = None
    kb_index_info = SimpleNamespace(index_owner_user_id=3, summary_enabled=False)
    gateway = MagicMock()
    gateway.index_document = AsyncMock(
        return_value={
            "status": "skipped",
            "reason": "retriever_not_found",
            "indexed_count": 0,
            "index_name": "unknown",
        }
    )

    with (
        patch(
            "app.services.knowledge.indexing.resolve_kb_index_info",
            return_value=kb_index_info,
        ),
        patch(
            "app.services.knowledge.indexing.RagRuntimeResolver.build_index_runtime_spec",
            return_value=object(),
        ) as mock_build_runtime_spec,
        patch(
            "app.services.knowledge.indexing.get_index_gateway",
            return_value=gateway,
        ),
    ):
        result = run_document_indexing(
            knowledge_base_id="1",
            attachment_id=2,
            retriever_name="retriever-1",
            retriever_namespace="default",
            embedding_model_name="embedding-1",
            embedding_model_namespace="default",
            user_id=3,
            user_name="tester",
            document_id=4,
            kb_index_info=kb_index_info,
            trigger_summary=False,
            db=db,
        )

    gateway.index_document.assert_awaited_once_with(
        mock_build_runtime_spec.return_value,
        db=db,
    )
    assert result == {
        "status": "skipped",
        "reason": "retriever_not_found",
        "document_id": 4,
        "knowledge_base_id": "1",
        "indexed_count": 0,
        "index_name": "unknown",
        "chunks_data": None,
    }


def test_run_document_indexing_normalizes_empty_splitter_config_for_runtime_spec() -> (
    None
):
    db = MagicMock()
    db.query.return_value.filter.return_value.first.return_value = None
    kb_index_info = SimpleNamespace(index_owner_user_id=3, summary_enabled=False)
    gateway = MagicMock()
    gateway.index_document = AsyncMock(
        return_value={"status": "success", "indexed_count": 1, "index_name": "kb_1"}
    )

    with (
        patch(
            "app.services.knowledge.indexing.resolve_kb_index_info",
            return_value=kb_index_info,
        ),
        patch(
            "app.services.knowledge.indexing.RagRuntimeResolver.build_index_runtime_spec",
            return_value=object(),
        ) as mock_build_runtime_spec,
        patch(
            "app.services.knowledge.indexing.get_index_gateway",
            return_value=gateway,
        ),
    ):
        run_document_indexing(
            knowledge_base_id="1",
            attachment_id=2,
            retriever_name="retriever-1",
            retriever_namespace="default",
            embedding_model_name="embedding-1",
            embedding_model_namespace="default",
            user_id=3,
            user_name="tester",
            splitter_config_dict={},
            document_id=4,
            kb_index_info=kb_index_info,
            trigger_summary=False,
            db=db,
        )

    assert mock_build_runtime_spec.call_args.kwargs["splitter_config_dict"] == {
        "chunk_strategy": "flat",
        "format_enhancement": "file_aware",
        "flat_config": {
            "chunk_size": 1024,
            "chunk_overlap": 50,
            "separator": "\n\n",
        },
        "markdown_enhancement": {"enabled": True},
    }


def test_run_document_indexing_normalizes_legacy_splitter_config_for_runtime_spec() -> (
    None
):
    db = MagicMock()
    db.query.return_value.filter.return_value.first.return_value = None
    kb_index_info = SimpleNamespace(index_owner_user_id=3, summary_enabled=False)
    gateway = MagicMock()
    gateway.index_document = AsyncMock(
        return_value={"status": "success", "indexed_count": 1, "index_name": "kb_1"}
    )

    with (
        patch(
            "app.services.knowledge.indexing.resolve_kb_index_info",
            return_value=kb_index_info,
        ),
        patch(
            "app.services.knowledge.indexing.RagRuntimeResolver.build_index_runtime_spec",
            return_value=object(),
        ) as mock_build_runtime_spec,
        patch(
            "app.services.knowledge.indexing.get_index_gateway",
            return_value=gateway,
        ),
    ):
        run_document_indexing(
            knowledge_base_id="1",
            attachment_id=2,
            retriever_name="retriever-1",
            retriever_namespace="default",
            embedding_model_name="embedding-1",
            embedding_model_namespace="default",
            user_id=3,
            user_name="tester",
            splitter_config_dict={"type": "smart"},
            document_id=4,
            kb_index_info=kb_index_info,
            trigger_summary=False,
            db=db,
        )

    assert mock_build_runtime_spec.call_args.kwargs["splitter_config_dict"] == {
        "chunk_strategy": "flat",
        "format_enhancement": "file_aware",
        "flat_config": {
            "chunk_size": 1024,
            "chunk_overlap": 50,
            "separator": "\n\n",
        },
        "markdown_enhancement": {"enabled": True},
        "legacy_type": "smart",
    }
