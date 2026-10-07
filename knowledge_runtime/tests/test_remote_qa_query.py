# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Remote QA behavior through persisted records, Runtime and the real kernel."""

from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from sqlalchemy.orm import Session

from knowledge_runtime.models.knowledge_document import KnowledgeDocument
from knowledge_runtime.services.config_loader import RuntimeConfigLoader
from knowledge_runtime.services.config_resolver import ConfigResolver
from knowledge_runtime.services.query_executor import QueryExecutor
from shared.models import (
    RemoteAuthorizedRetrievalResources,
    RemoteKnowledgeBaseRetrievalOverride,
    RemoteQueryRequest,
    RemoteQueryResponse,
    RetrievalScope,
    RuntimeRetrievalConfig,
    SearchHints,
)
from shared.models.db import Kind

QUERY = "微博 大广场模式 2025 有什么优势"


def authorized_for(db: Session, kb_id: int) -> RemoteAuthorizedRetrievalResources:
    kb = db.get(Kind, kb_id)
    rc = kb.json["spec"]["retrievalConfig"]
    return RemoteAuthorizedRetrievalResources(
        operation="query",
        knowledge_base_id=kb_id,
        index_owner_user_id=kb.user_id,
        retriever={
            "kind": "Retriever",
            "name": rc["retriever_name"],
            "namespace": rc.get("retriever_namespace", "default"),
        },
        embedding_model={
            "kind": "Model",
            "name": rc["embedding_config"]["model_name"],
            "namespace": rc["embedding_config"].get("model_namespace", "default"),
        },
    )


@pytest.fixture
def qa_query_db(shared_model_db: Session) -> Session:
    shared_model_db.add_all(
        [
            KnowledgeDocument(
                id=10,
                kind_id=1,
                is_active=True,
                chunks={"splitter_subtype": "qa_pair", "qa_pair_count": 2},
            ),
            KnowledgeDocument(id=11, kind_id=1, is_active=True, chunks=None),
            KnowledgeDocument(
                id=12,
                kind_id=1,
                is_active=False,
                chunks={"splitter_subtype": "qa_pair", "qa_pair_count": 5},
            ),
            KnowledgeDocument(
                id=20,
                kind_id=2,
                is_active=True,
                chunks={"splitter_subtype": "qa_pair", "qa_pair_count": 9},
            ),
        ]
    )
    shared_model_db.commit()
    return shared_model_db


def test_unscoped_qa_count_only_includes_active_documents_in_current_kb(
    qa_query_db: Session,
) -> None:
    qa_query_db.add(
        KnowledgeDocument(
            id=13,
            kind_id=1,
            is_active=True,
            chunks={"splitter_subtype": "qa_pair", "qa_pair_count": -3},
        )
    )
    qa_query_db.commit()

    config = ConfigResolver().resolve_query_config(
        qa_query_db,
        knowledge_base_id=1,
        user_id=42,
        authorized=authorized_for(qa_query_db, 1),
    )

    assert config.qa_pair_count == 2
    assert config.scoped_document_ids is None


async def run_query(
    db: Session,
    request: RemoteQueryRequest,
    mode: str = "hybrid",
    storage: Any = None,
    embed_model: Any = None,
) -> tuple[RemoteQueryResponse, Any]:
    kb = db.get(Kind, 1)
    spec = dict(kb.json["spec"])
    spec["retrievalConfig"] = {
        **spec["retrievalConfig"],
        "retrieval_mode": mode,
        "top_k": 7,
        "score_threshold": 0.25,
        "hybrid_weights": {"vector_weight": 0.85, "keyword_weight": 0.15},
    }
    kb.json = {"spec": spec}
    db.commit()
    if storage is None:
        storage = MagicMock()
        storage.supports_retrieval_scope = True
        storage.retrieve.return_value = {"records": []}
    request = request.model_copy(
        update={
            "authorized_resources": [
                authorized_for(db, kb_id) for kb_id in request.knowledge_base_ids
            ]
        }
    )
    loader = RuntimeConfigLoader(session_factory=lambda: db)
    with (
        patch(
            "knowledge_runtime.services.query_executor.create_storage_backend_from_runtime_config",
            return_value=storage,
        ),
        patch(
            "knowledge_runtime.services.query_executor.create_embedding_model_from_runtime_config",
            return_value=embed_model or object(),
        ),
    ):
        result = await QueryExecutor(config_loader=loader).execute(request)
    return result, storage


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["hybrid", "keyword", "vector"])
async def test_remote_uses_qa_plan_and_saved_config(
    qa_query_db: Session, mode: str
) -> None:
    _, storage = await run_query(
        qa_query_db,
        RemoteQueryRequest(
            knowledge_base_ids=[1],
            user_id=42,
            query=QUERY,
        ),
        mode,
    )
    setting = storage.retrieve.call_args.kwargs["retrieval_setting"]
    assert setting["retrieval_mode"] == mode
    assert setting["top_k"] == 7
    assert setting["score_threshold"] == 0.25
    if mode == "hybrid":
        assert setting["vector_weight"] == 0.85
        assert setting["keyword_weight"] == 0.15
    else:
        assert "vector_weight" not in setting
        assert "keyword_weight" not in setting
    assert setting["dense_query"] == QUERY
    assert "大广场模式" in setting["phrases"]
    assert "2025" in setting["keywords"]
    assert setting["hint_source"] == "qa_pair_profile"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "hints",
    [
        SearchHints(),
        SearchHints(
            semantic_query="release check",
            keywords=["release"],
            phrases=["release check"],
        ),
    ],
)
async def test_explicit_hints_override_automatic_qa_plan(
    qa_query_db: Session, hints: SearchHints
) -> None:
    _, storage = await run_query(
        qa_query_db,
        RemoteQueryRequest(
            knowledge_base_ids=[1],
            user_id=42,
            query=QUERY,
            search_hints=hints,
        ),
    )
    setting = storage.retrieve.call_args.kwargs["retrieval_setting"]
    assert setting["hint_source"] != "qa_pair_profile"
    assert setting["keywords"] == (hints.keywords or [])
    assert setting["phrases"] == (hints.phrases or [])
    assert setting["dense_query"] == (hints.semantic_query or QUERY)


@pytest.mark.asyncio
@pytest.mark.parametrize("compatibility_scope", [False, True])
async def test_out_of_scope_inactive_and_other_kb_qa_do_not_affect_plan(
    qa_query_db: Session,
    compatibility_scope: bool,
) -> None:
    scope_args = (
        {"document_ids": [11, 12, 20]}
        if compatibility_scope
        else {
            "scope": RetrievalScope(document_ids=[11, 12, 20]),
        }
    )
    _, storage = await run_query(
        qa_query_db,
        RemoteQueryRequest(
            knowledge_base_ids=[1],
            user_id=42,
            query=QUERY,
            **scope_args,
        ),
    )
    args = storage.retrieve.call_args.kwargs
    assert args["scope"].document_ids == [11]
    assert args["retrieval_setting"]["hint_source"] == "fallback"
    assert args["retrieval_setting"]["keywords"] == []
    assert args["retrieval_setting"]["phrases"] == []


@pytest.mark.asyncio
async def test_empty_effective_scope_returns_empty_without_storage_query(
    qa_query_db: Session,
) -> None:
    with patch.object(QueryExecutor, "_build_query_target") as build_target:
        result, storage = await run_query(
            qa_query_db,
            RemoteQueryRequest(
                knowledge_base_ids=[1],
                user_id=42,
                query=QUERY,
                scope=RetrievalScope(document_ids=[12, 20, 99]),
            ),
        )
    build_target.assert_not_called()
    assert result.records == []
    assert result.total == 0
    storage.retrieve.assert_not_called()


@pytest.mark.asyncio
async def test_legal_override_preserves_qa_plan_and_configured_parameters(
    qa_query_db: Session,
) -> None:
    _, storage = await run_query(
        qa_query_db,
        RemoteQueryRequest(
            knowledge_base_ids=[1],
            user_id=42,
            query=QUERY,
            scope=RetrievalScope(document_ids=[10]),
            knowledge_base_retrieval_overrides=[
                RemoteKnowledgeBaseRetrievalOverride(
                    knowledge_base_id=1,
                    retrieval_config=RuntimeRetrievalConfig(
                        top_k=3,
                        score_threshold=0.1,
                        retrieval_mode="hybrid",
                        vector_weight=0.9,
                        keyword_weight=0.1,
                    ),
                )
            ],
        ),
        "vector",
    )
    args = storage.retrieve.call_args.kwargs
    setting = args["retrieval_setting"]
    assert setting["retrieval_mode"] == "hybrid"
    assert setting["top_k"] == 3
    assert setting["score_threshold"] == 0.1
    assert setting["vector_weight"] == 0.9
    assert setting["keyword_weight"] == 0.1
    assert setting["hint_source"] == "qa_pair_profile"
    assert args["scope"].document_ids == [10]


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["vector", "hybrid", "keyword"])
async def test_remote_plan_reaches_actual_storage_query(
    qa_query_db: Session, mode: str
) -> None:
    from llama_index.core.schema import TextNode
    from llama_index.core.vector_stores.types import VectorStoreQueryMode

    from knowledge_engine.storage.elasticsearch_backend import ElasticsearchBackend

    store = MagicMock()
    store.query.return_value = MagicMock(
        nodes=[TextNode(text="below threshold"), TextNode(text="answer")],
        similarities=[0.2, 0.9],
    )
    embed_model = MagicMock()
    embed_model.get_query_embedding.return_value = [0.1, 0.2]
    with (
        patch("knowledge_engine.storage.elasticsearch_backend.Elasticsearch"),
        patch(
            "knowledge_engine.storage.elasticsearch_backend.ElasticsearchStore",
            return_value=store,
        ),
    ):
        storage = ElasticsearchBackend({"url": "http://localhost:9200"})
        result, _ = await run_query(
            qa_query_db,
            RemoteQueryRequest(
                knowledge_base_ids=[1],
                user_id=42,
                query=QUERY,
                scope=RetrievalScope(document_ids=[10]),
            ),
            mode,
            storage,
            embed_model,
        )
    query = store.query.call_args.args[0]
    assert query.similarity_top_k == 7
    assert [record.content for record in result.records] == ["answer"]
    if mode == "vector":
        assert query.mode == VectorStoreQueryMode.DEFAULT
        assert query.query_str == QUERY
        assert query.alpha is None
    elif mode == "hybrid":
        assert query.mode == VectorStoreQueryMode.HYBRID
        assert query.alpha == 0.85
        assert '"大广场模式"' in query.query_str
    else:
        assert query.mode == VectorStoreQueryMode.TEXT_SEARCH
        assert query.query_embedding is None
        embed_model.get_query_embedding.assert_not_called()
        assert '"大广场模式"' in query.query_str
    if mode != "keyword":
        embed_model.get_query_embedding.assert_called_once_with(QUERY)
    body = store.query.call_args.kwargs["custom_query"](
        {"query": {"match_all": {}}}, None
    )
    filters = body["query"]["bool"]["filter"]
    assert {"terms": {"metadata.doc_ref.keyword": ["10"]}} in filters
    if mode == "vector":
        assert "should" not in body["query"]["bool"]
    else:
        assert {
            "match_phrase": {"content": {"query": "大广场模式", "boost": 3.0}}
        } in body["query"]["bool"]["should"]


@pytest.mark.asyncio
async def test_qa_plan_is_per_knowledge_base(qa_query_db: Session) -> None:
    kb = qa_query_db.get(Kind, 1)
    qa_query_db.add(
        Kind(
            id=4,
            user_id=42,
            kind="KnowledgeBase",
            name="ordinary-kb",
            namespace="search-team",
            is_active=True,
            json=kb.json,
        )
    )
    qa_query_db.commit()
    _, storage = await run_query(
        qa_query_db,
        RemoteQueryRequest(
            knowledge_base_ids=[1, 4],
            user_id=42,
            query=QUERY,
        ),
    )
    settings = {
        call.kwargs["knowledge_id"]: call.kwargs["retrieval_setting"]
        for call in storage.retrieve.call_args_list
    }
    assert settings["1"]["hint_source"] == "qa_pair_profile"
    assert settings["4"]["hint_source"] == "fallback"
    assert settings["4"]["keywords"] == []


@pytest.mark.asyncio
@pytest.mark.parametrize("explicit_hints", [False, True])
@pytest.mark.parametrize("compatibility_scope", [False, True])
async def test_multi_kb_scope_is_clipped_before_independent_planning(
    qa_query_db: Session, explicit_hints: bool, compatibility_scope: bool
) -> None:
    kb = qa_query_db.get(Kind, 1)
    qa_query_db.add_all(
        [
            Kind(
                id=4,
                user_id=42,
                kind="KnowledgeBase",
                name="ordinary-kb",
                namespace="search-team",
                is_active=True,
                json=kb.json,
            ),
            Kind(
                id=5,
                user_id=42,
                kind="KnowledgeBase",
                name="empty-kb",
                namespace="search-team",
                is_active=True,
                json=kb.json,
            ),
            KnowledgeDocument(id=40, kind_id=4, is_active=True, chunks=None),
        ]
    )
    qa_query_db.commit()
    document_ids = [10, 12, 20, 40, 99]
    scope_args = (
        {"document_ids": document_ids}
        if compatibility_scope
        else {"scope": RetrievalScope(document_ids=document_ids)}
    )
    _, storage = await run_query(
        qa_query_db,
        RemoteQueryRequest(
            knowledge_base_ids=[1, 4, 5],
            user_id=42,
            query=QUERY,
            search_hints=(
                SearchHints(semantic_query="release check", keywords=["release"])
                if explicit_hints
                else None
            ),
            **scope_args,
        ),
    )

    calls = {
        call.kwargs["knowledge_id"]: call.kwargs
        for call in storage.retrieve.call_args_list
    }
    assert storage.retrieve.call_count == 2
    assert set(calls) == {"1", "4"}
    assert calls["1"]["scope"].document_ids == [10]
    assert calls["4"]["scope"].document_ids == [40]
    settings = {kb_id: call["retrieval_setting"] for kb_id, call in calls.items()}
    if explicit_hints:
        for setting in settings.values():
            assert setting["hint_source"] == "explicit_hints"
            assert setting["dense_query"] == "release check"
            assert setting["keywords"] == ["release"]
    else:
        assert settings["1"]["hint_source"] == "qa_pair_profile"
        assert settings["4"]["hint_source"] == "fallback"
        assert settings["4"]["keywords"] == []


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["vector", "hybrid", "keyword"])
async def test_override_without_weights_does_not_inject_qa_weights(
    qa_query_db: Session, mode: str
) -> None:
    _, storage = await run_query(
        qa_query_db,
        RemoteQueryRequest(
            knowledge_base_ids=[1],
            user_id=42,
            query=QUERY,
            knowledge_base_retrieval_overrides=[
                RemoteKnowledgeBaseRetrievalOverride(
                    knowledge_base_id=1,
                    retrieval_config=RuntimeRetrievalConfig(
                        top_k=3,
                        score_threshold=0.1,
                        retrieval_mode=mode,
                    ),
                )
            ],
        ),
    )
    setting = storage.retrieve.call_args.kwargs["retrieval_setting"]
    assert setting["retrieval_mode"] == mode
    assert setting["top_k"] == 3
    assert setting["score_threshold"] == 0.1
    if mode == "hybrid":
        assert setting["vector_weight"] == 0.85
        assert setting["keyword_weight"] == 0.15
    else:
        assert "vector_weight" not in setting
        assert "keyword_weight" not in setting
    assert setting["hint_source"] == "qa_pair_profile"
