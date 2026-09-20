# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.knowledge.indexing import run_document_indexing
from app.services.rag.runtime_specs import DeleteRuntimeSpec, IndexRuntimeSpec
from shared.models import RuntimeEmbeddingModelConfig, RuntimeRetrieverConfig


def _spec_without_a_resolved_retriever_config() -> SimpleNamespace:
    """A runtime spec whose storage config these tests do not resolve."""
    return SimpleNamespace(retriever_config=None)


def _kb_record(retriever_name: str) -> SimpleNamespace:
    """The knowledge base row the resolver reads its retrieval config from."""
    return SimpleNamespace(
        user_id=3,
        json={"spec": {"retrievalConfig": {"retriever_name": retriever_name}}},
    )


def _resolved_retriever_config(
    storage_type: str,
    index_strategy: dict | None = None,
) -> RuntimeRetrieverConfig:
    return RuntimeRetrieverConfig(
        name="retriever-1",
        namespace="default",
        storage_config={
            "type": storage_type,
            "url": "http://vector-store:19530",
            "indexStrategy": index_strategy or {"mode": "per_dataset"},
        },
    )


def _run_indexing_against_storage(
    *,
    storage_type: str = "milvus",
    index_strategy: dict | None = None,
    retriever_name: str = "retriever-1",
) -> tuple[MagicMock, list[str], dict]:
    """Run the real indexing chain against one resolved storage config.

    Only the resolver's control-plane lookups (the knowledge base row, the
    retriever config and the embedding model config) and the gateway are
    faked: the runtime specs, the storage decision and the index call order are
    the product's own chain. Which engine answers the config is the storage
    factory's decision, so the cases below differ only in the config a Retriever
    declared - never in its name.
    """
    db = MagicMock()
    db.query.return_value.filter.return_value.first.return_value = None
    kb_index_info = SimpleNamespace(index_owner_user_id=3, summary_enabled=False)
    calls: list[str] = []
    gateway = MagicMock()

    async def fake_delete_document_index(
        spec: DeleteRuntimeSpec, db: object = None
    ) -> dict:
        calls.append("delete_document_index")
        return {"deleted_chunks": 1}

    async def fake_index_document(spec: IndexRuntimeSpec, db: object = None) -> dict:
        calls.append("index_document")
        return {"status": "success", "indexed_count": 1, "index_name": "idx"}

    gateway.delete_document_index = AsyncMock(side_effect=fake_delete_document_index)
    gateway.index_document = AsyncMock(side_effect=fake_index_document)

    with (
        patch(
            "app.services.knowledge.indexing.resolve_kb_index_info",
            return_value=kb_index_info,
        ),
        patch(
            "app.services.rag.runtime_resolver.RagRuntimeResolver._get_knowledge_base_record",
            return_value=_kb_record(retriever_name),
        ),
        patch(
            "app.services.rag.runtime_resolver.RagRuntimeResolver._build_resolved_retriever_config",
            return_value=_resolved_retriever_config(storage_type, index_strategy),
        ),
        patch(
            "app.services.rag.runtime_resolver.RagRuntimeResolver._build_resolved_embedding_model_config",
            return_value=RuntimeEmbeddingModelConfig(
                model_name="embedding-1",
                model_namespace="default",
                resolved_config={"protocol": "openai"},
            ),
        ),
        patch(
            "app.services.knowledge.indexing.get_index_gateway",
            return_value=gateway,
        ),
    ):
        result = run_document_indexing(
            knowledge_base_id="1",
            attachment_id=2,
            retriever_name=retriever_name,
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

    return gateway, calls, result


def test_the_reserved_prefix_write_leaves_the_delete_to_the_backend() -> None:
    """The V2 write replaces the document, so indexing must not pre-delete.

    ``type: milvus`` with the reserved prefix resolves to the adapter that
    deletes the document's previous rows inside its own write, after it
    confirms the collection contract, so a business pre-delete would delete the
    same rows twice and race the write that owns them. The retriever is named
    like a legacy one, because the name is not what decides this.
    """
    gateway, calls, result = _run_indexing_against_storage(
        index_strategy={"mode": "per_dataset", "prefix": "wegent_v2"},
        retriever_name="legacy-retriever",
    )

    assert result["status"] == "success"
    assert calls == ["index_document"]
    gateway.delete_document_index.assert_not_awaited()
    gateway.index_document.assert_awaited_once()


@pytest.mark.parametrize(
    "index_strategy",
    [
        pytest.param({"mode": "per_dataset"}, id="default-prefix"),
        pytest.param({"mode": "per_dataset", "prefix": "wegent"}, id="wegent-prefix"),
    ],
)
def test_an_ordinary_prefix_retriever_keeps_its_pre_delete(
    index_strategy: dict,
) -> None:
    """The legacy Milvus adapter receives the document's old index deleted.

    ``milvus`` without the reserved prefix serves the collections the online
    main branch wrote, and that adapter owns no document replacement of its
    own, so the business layer must keep deleting a document's previous rows
    before it indexes the new version.
    """
    gateway, calls, _ = _run_indexing_against_storage(index_strategy=index_strategy)

    assert calls == ["delete_document_index", "index_document"]
    delete_spec = gateway.delete_document_index.await_args.args[0]
    assert delete_spec.document_ref == "4"
    assert delete_spec.retriever_config.storage_config["type"] == "milvus"
    gateway.index_document.assert_awaited_once()


def test_a_non_milvus_retriever_keeps_the_delete_then_index_order() -> None:
    """Every other engine keeps the existing pre-delete before indexing.

    The engine comes from the storage config the runtime resolved, so a
    retriever whose name says milvus but whose storage is Elasticsearch still
    deletes its old index first.
    """
    gateway, calls, _ = _run_indexing_against_storage(
        storage_type="elasticsearch",
        retriever_name="milvus-retriever",
    )

    assert calls == ["delete_document_index", "index_document"]
    delete_spec = gateway.delete_document_index.await_args.args[0]
    assert delete_spec.document_ref == "4"
    assert delete_spec.retriever_config.storage_config["type"] == "elasticsearch"
    gateway.index_document.assert_awaited_once()


def test_run_document_indexing_closes_owned_session_before_gateway_call() -> None:
    # preparation_db is owned by run_document_indexing (own_session=True path)
    preparation_db = MagicMock()
    preparation_db.closed = False
    preparation_db.query.return_value.filter.return_value.first.return_value = None

    def close_preparation_db() -> None:
        preparation_db.closed = True

    preparation_db.close.side_effect = close_preparation_db

    kb_index_info = SimpleNamespace(index_owner_user_id=3, summary_enabled=False)
    gateway = MagicMock()

    async def fake_index_document(runtime_spec: object, db: object = None) -> dict:
        # The preparation session must already be closed when the gateway is called
        assert preparation_db.closed is True
        # Gateway owns any DB prefetch it needs, so indexing does not pass a live session.
        assert db is None
        return {"status": "success", "indexed_count": 1, "index_name": "idx"}

    gateway.index_document.side_effect = fake_index_document

    with (
        patch(
            "app.services.knowledge.indexing.SessionLocal",
            return_value=preparation_db,
        ) as mock_session_local,
        patch(
            "app.services.knowledge.indexing.resolve_kb_index_info",
            return_value=kb_index_info,
        ),
        patch(
            "app.services.knowledge.indexing.RagRuntimeResolver.build_index_runtime_spec",
            return_value=_spec_without_a_resolved_retriever_config(),
        ),
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
            document_id=None,
            trigger_summary=False,
        )

    assert result["status"] == "success"
    mock_session_local.assert_called_once()
    preparation_db.close.assert_called_once()


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
            return_value=_spec_without_a_resolved_retriever_config(),
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
        db=None,
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
            return_value=_spec_without_a_resolved_retriever_config(),
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
            return_value=_spec_without_a_resolved_retriever_config(),
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
