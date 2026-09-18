# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Real-Milvus contract tests for scoped keyword retrieval.

These tests drive the public write and query entry points against a real Milvus
service and assert real hits, real filters and real metadata semantics - not
SDK call shapes. The verified combination is the one the CI job starts:

- server: Milvus 2.5.4 (tests/contract/docker-compose.milvus.yml)
- SDK: pymilvus 2.6.3 (pinned in knowledge_engine/uv.lock)
- analyzer: field-level ``chinese`` on ``retrieval_text``

The analyzer must be declared on the field itself. A collection-level analyzer
leaves BM25 queries unanalyzed on this server version, which answers Chinese
queries with zero hits instead of failing - exactly the silent degradation
these tests exist to catch.
"""

from __future__ import annotations

import asyncio
import uuid

import pytest
from llama_index.core.schema import TextNode
from pymilvus import DataType, MilvusClient

from knowledge_engine.query.executor import QueryExecutor
from knowledge_engine.services.document_service import DocumentService
from knowledge_engine.storage.chunk_metadata import ChunkMetadata
from knowledge_engine.storage.errors import IndexContractIncompatibleError
from knowledge_engine.storage.milvus_backend import MilvusBackend
from knowledge_engine.storage.milvus_native import (
    INDEX_TYPE,
    METRIC_TYPE,
    SCHEMA_VERSION,
    MilvusIndexBinding,
    index_contract_description,
)
from shared.models import RetrievalScope

from .conftest import (
    DeterministicEmbedding,
    MilvusContractEnv,
    await_document_visibility,
)

pytestmark = pytest.mark.milvus

DIMENSION = 1536


class EmbeddingBan:
    """Fails the test if a keyword query reaches the embedding provider."""

    model_name = "contract-model"
    _configured_dimension = DIMENSION

    def get_query_embedding(self, query):
        raise AssertionError("keyword retrieval must not build a query vector")

    def get_text_embedding_batch(self, texts, **kwargs):
        raise AssertionError("keyword retrieval must not embed text")


def _chunk_metadata(knowledge_id: str, doc_ref: str) -> ChunkMetadata:
    return ChunkMetadata(
        knowledge_id=knowledge_id,
        doc_ref=doc_ref,
        source_file=f"document-{doc_ref}.txt",
        created_at="2026-01-01T00:00:00Z",
    )


def _index_nodes(
    backend: MilvusBackend,
    *,
    knowledge_id: str,
    doc_ref: str,
    nodes: list[TextNode],
    model=None,
) -> DeterministicEmbedding:
    """Write nodes through the storage entry the document service uses."""
    model = model or DeterministicEmbedding(DIMENSION)
    chunk_metadata = _chunk_metadata(knowledge_id, doc_ref)
    chunk_metadata.apply_to_nodes(nodes)
    backend.index_with_metadata(
        nodes=nodes,
        chunk_metadata=chunk_metadata,
        embed_model=model,
    )
    await_document_visibility(
        backend,
        knowledge_id=knowledge_id,
        doc_ref=doc_ref,
        expected_chunks=len(nodes),
    )
    return model


def _index_text_document(
    env: MilvusContractEnv,
    *,
    knowledge_id: str,
    document_id: int,
    text: str,
    backend: MilvusBackend | None = None,
) -> MilvusBackend:
    """Index one document through the public document service."""
    backend = backend or env.backend()
    service = DocumentService(storage_backend=backend)
    result = asyncio.run(
        service.index_document_from_binary(
            knowledge_id=knowledge_id,
            binary_data=text.encode("utf-8"),
            source_file=f"document-{document_id}.txt",
            file_extension=".txt",
            embed_model=DeterministicEmbedding(DIMENSION),
            user_id=1,
            document_id=document_id,
        )
    )
    await_document_visibility(
        backend,
        knowledge_id=knowledge_id,
        doc_ref=str(document_id),
        expected_chunks=result["chunk_count"],
    )
    return backend


def _keyword_query(
    backend: MilvusBackend,
    *,
    knowledge_id: str,
    query: str,
    model=None,
    top_k: int = 10,
    score_threshold: float = 0.0,
    scope: RetrievalScope | None = None,
    metadata_condition: dict | None = None,
) -> dict:
    executor = QueryExecutor(
        storage_backend=backend,
        embed_model=model or EmbeddingBan(),
    )
    return asyncio.run(
        executor.execute(
            knowledge_id=knowledge_id,
            query=query,
            retrieval_config={
                "top_k": top_k,
                "score_threshold": score_threshold,
                "retrieval_mode": "keyword",
            },
            scope=scope,
            metadata_condition=metadata_condition,
            user_id=1,
        )
    )


def _doc_refs(result: dict) -> set[str]:
    return {record["metadata"]["doc_ref"] for record in result["records"]}


def test_keyword_hits_chinese_english_and_code_identifiers(
    milvus_env: MilvusContractEnv,
) -> None:
    """Chinese words, English words and code identifiers all recall the chunk."""
    knowledge_id = milvus_env.new_knowledge_id()
    backend = _index_text_document(
        milvus_env,
        knowledge_id=knowledge_id,
        document_id=7001,
        text=(
            "知识库检索系统支持中文分词与向量召回。\n"
            "The retrieval pipeline scores candidates with BM25 in Milvus.\n"
            "调用 get_user_by_id 可以按用户标识获取资料。\n"
            "当前版本 Qwen3-Embedding 0.6B 于 2026 年发布，"
            "配置项 max_batch_size=32。"
        ),
    )

    # Chinese words, English words, digits, underscores and code identifiers
    # all recall the chunk through the server-side analyzer.
    for query in ("中文分词", "BM25", "2026", "get_user_by_id", "max_batch_size"):
        result = _keyword_query(backend, knowledge_id=knowledge_id, query=query)

        assert result["records"], f"expected real keyword hits for {query!r}"
        assert _doc_refs(result) == {"7001"}
        assert all(record["score"] > 0.0 for record in result["records"])
        assert all(record["content"] for record in result["records"])

    unrelated = _keyword_query(
        backend,
        knowledge_id=knowledge_id,
        query="火星探测器着陆计划",
    )
    assert unrelated == {"records": []}

    # The reported score is the raw BM25 score Milvus returned, and the
    # existing threshold field filters on that same value: the boundary keeps
    # the hit and a score above it cuts it.
    observed = max(
        record["score"]
        for record in _keyword_query(
            backend, knowledge_id=knowledge_id, query="中文分词"
        )["records"]
    )
    assert observed > 0.0
    assert _keyword_query(
        backend,
        knowledge_id=knowledge_id,
        query="中文分词",
        score_threshold=observed,
    )["records"]
    assert _keyword_query(
        backend,
        knowledge_id=knowledge_id,
        query="中文分词",
        score_threshold=observed + 1.0,
    ) == {"records": []}


def test_keyword_returns_display_text_while_matching_retrieval_text(
    milvus_env: MilvusContractEnv,
) -> None:
    """BM25 indexes the retrieval text; the caller still reads display text."""
    knowledge_id = milvus_env.new_knowledge_id()
    backend = milvus_env.backend()
    _index_nodes(
        backend,
        knowledge_id=knowledge_id,
        doc_ref="7901",
        nodes=[
            TextNode(
                text="展示正文：面向用户的完整回答",
                metadata={
                    "retrieval_text": "内部检索提示词 get_internal_token_by_id",
                    "display_text": "展示正文：面向用户的完整回答",
                    "heading_path": "docs",
                },
            )
        ],
    )

    hit = _keyword_query(
        backend,
        knowledge_id=knowledge_id,
        query="get_internal_token_by_id",
    )

    assert _doc_refs(hit) == {"7901"}
    assert hit["records"][0]["content"] == "展示正文：面向用户的完整回答"

    display_only = _keyword_query(
        backend,
        knowledge_id=knowledge_id,
        query="展示正文",
    )
    assert display_only == {"records": []}


def test_keyword_succeeds_when_vector_generation_is_forbidden(
    milvus_env: MilvusContractEnv,
) -> None:
    """A keyword query is answered from the BM25 index alone."""
    knowledge_id = milvus_env.new_knowledge_id()
    backend = _index_text_document(
        milvus_env,
        knowledge_id=knowledge_id,
        document_id=7101,
        text="关键词召回不依赖 embedding 提供方。",
    )

    result = _keyword_query(
        backend,
        knowledge_id=knowledge_id,
        query="关键词召回",
        model=EmbeddingBan(),
    )

    assert _doc_refs(result) == {"7101"}


def test_shared_physical_index_keeps_every_hit_inside_scope(
    milvus_env: MilvusContractEnv,
) -> None:
    """Two knowledge bases in one collection never leak into each other."""
    rolling_backend = MilvusBackend(
        {
            "url": milvus_env.uri,
            "indexStrategy": {
                "mode": "rolling",
                "prefix": "wegent_scope",
                "rollingStep": 10,
            },
            "ext": {"timeout": 30.0},
        }
    )
    first_kb, second_kb = "7201", "7202"
    collection_name = rolling_backend.get_index_name(first_kb)
    try:
        _index_text_document(
            milvus_env,
            knowledge_id=first_kb,
            document_id=7201,
            text="共享物理索引中的第一份文档，主题是向量检索。",
            backend=rolling_backend,
        )
        _index_text_document(
            milvus_env,
            knowledge_id=first_kb,
            document_id=7202,
            text="同一知识库的第二份文档，主题是索引分片。",
            backend=rolling_backend,
        )
        _index_text_document(
            milvus_env,
            knowledge_id=second_kb,
            document_id=7301,
            text="越界内容：zebra_pipeline 只属于另一个知识库。",
            backend=rolling_backend,
        )

        assert rolling_backend.get_index_name(second_kb) == collection_name

        out_of_scope = _keyword_query(
            rolling_backend,
            knowledge_id=first_kb,
            query="zebra_pipeline",
        )
        assert out_of_scope == {"records": []}, "out-of-scope content must not leak"

        own = _keyword_query(
            rolling_backend,
            knowledge_id=first_kb,
            query="向量检索",
        )
        assert _doc_refs(own) == {"7201"}

        single_document = _keyword_query(
            rolling_backend,
            knowledge_id=first_kb,
            query="索引分片",
            scope=RetrievalScope(document_ids=[7202]),
        )
        assert _doc_refs(single_document) == {"7202"}

        other_kb = _keyword_query(
            rolling_backend,
            knowledge_id=second_kb,
            query="zebra_pipeline",
        )
        assert _doc_refs(other_kb) == {"7301"}
    finally:
        _drop_shared_index(milvus_env, collection_name)


def test_a_fixed_collection_keeps_every_read_inside_scope(
    milvus_env: MilvusContractEnv,
) -> None:
    """The fully shared strategy: every knowledge base in one fixed name.

    One collection serves every knowledge base here, so the scope has to hold
    for the keyword route, the reading paths and the delete path alike.
    """
    collection_name = f"wegent_fixed_{uuid.uuid4().hex[:8]}"
    backend = MilvusBackend(
        {
            "url": milvus_env.uri,
            "indexStrategy": {"mode": "fixed", "fixedName": collection_name},
            "ext": {"timeout": 30.0},
        }
    )
    first_kb, second_kb = "7601", "7602"
    try:
        assert backend.get_index_name(first_kb) == collection_name
        assert backend.get_index_name(second_kb) == collection_name
        _index_text_document(
            milvus_env,
            knowledge_id=first_kb,
            document_id=7601,
            text="固定集合中的第一份文档，主题是范围隔离。",
            backend=backend,
        )
        _index_text_document(
            milvus_env,
            knowledge_id=second_kb,
            document_id=7602,
            text="越界内容：quasar_marker 只属于另一个知识库。",
            backend=backend,
        )

        assert _keyword_query(
            backend, knowledge_id=first_kb, query="quasar_marker"
        ) == {"records": []}, "out-of-scope content must not leak"
        assert _doc_refs(
            _keyword_query(backend, knowledge_id=first_kb, query="范围隔离")
        ) == {"7601"}
        assert _doc_refs(
            _keyword_query(backend, knowledge_id=second_kb, query="quasar_marker")
        ) == {"7602"}

        assert [
            document["doc_ref"]
            for document in backend.list_documents(first_kb)["documents"]
        ] == ["7601"]
        assert {chunk["doc_ref"] for chunk in backend.get_all_chunks(first_kb)} == {
            "7601"
        }
        with pytest.raises(ValueError):
            backend.get_document(first_kb, "7602")

        deleted = backend.delete_document(first_kb, "7601")
        assert deleted["deleted_chunks"] >= 1
        assert _doc_refs(
            _keyword_query(backend, knowledge_id=second_kb, query="quasar_marker")
        ) == {"7602"}, "clearing one knowledge base must not touch the other"
    finally:
        _drop_shared_index(milvus_env, collection_name)


def test_a_shared_collection_refuses_an_incompatible_dataset(
    milvus_env: MilvusContractEnv,
) -> None:
    """The collection contract is one for every dataset it holds.

    A second dataset that would need another embedding space must fail before
    anything is written or removed, and the dataset already stored must stay
    readable.
    """
    collection_name = f"wegent_shared_{uuid.uuid4().hex[:8]}"
    backend = MilvusBackend(
        {
            "url": milvus_env.uri,
            "indexStrategy": {"mode": "fixed", "fixedName": collection_name},
            "ext": {"timeout": 30.0},
        }
    )
    first_kb, second_kb = "7701", "7702"
    try:
        _index_text_document(
            milvus_env,
            knowledge_id=first_kb,
            document_id=7701,
            text="共用集合中的第一份数据集文档，主题是嵌入空间契约。",
            backend=backend,
        )

        with pytest.raises(IndexContractIncompatibleError):
            backend.index_with_metadata(
                nodes=[TextNode(text="第二个数据集声明另一个嵌入空间。")],
                chunk_metadata=_chunk_metadata(second_kb, "7702"),
                embed_model=DeterministicEmbedding(DIMENSION, model_name="other-model"),
            )

        assert _doc_refs(
            _keyword_query(backend, knowledge_id=first_kb, query="嵌入空间契约")
        ) == {"7701"}, "the incompatible write must not disturb the stored dataset"
        assert backend.get_all_chunks(second_kb) == [], "nothing was written"
    finally:
        _drop_shared_index(milvus_env, collection_name)


def test_metadata_filter_is_applied_before_the_top_k_cut(
    milvus_env: MilvusContractEnv,
) -> None:
    """A matching record behind many non-matching ones is still recalled."""
    knowledge_id = milvus_env.new_knowledge_id()
    backend = milvus_env.backend()
    filler = [
        TextNode(
            text="alpha " * 20 + f"filler chunk {index}",
            metadata={"heading_path": "filler", "chunk_index": index},
        )
        for index in range(20)
    ]
    _index_nodes(
        backend,
        knowledge_id=knowledge_id,
        doc_ref="7401",
        nodes=filler,
    )
    _index_nodes(
        backend,
        knowledge_id=knowledge_id,
        doc_ref="7402",
        nodes=[TextNode(text="alpha", metadata={"heading_path": "target"})],
    )

    unfiltered = _keyword_query(
        backend,
        knowledge_id=knowledge_id,
        query="alpha",
        top_k=5,
    )
    assert _doc_refs(unfiltered) == {"7401"}, "filler rows outrank the target"

    filtered = _keyword_query(
        backend,
        knowledge_id=knowledge_id,
        query="alpha",
        top_k=5,
        metadata_condition={
            "operator": "and",
            "conditions": [
                {"key": "heading_path", "operator": "eq", "value": "target"}
            ],
        },
    )
    assert _doc_refs(filtered) == {"7402"}


def test_metadata_conditions_keep_the_supported_contract(
    milvus_env: MilvusContractEnv,
) -> None:
    """The whitelist, flat AND, eq/in and the ``==`` alias on real Milvus."""
    knowledge_id = milvus_env.new_knowledge_id()
    backend = milvus_env.backend()
    rows = {
        "7501": {
            "file_name": "tech.md",
            "page_number": 2024,
            "heading_path": 'a"b\\c',
            "chunk_strategy": "flat",
        },
        "7502": {"file_name": "db.md", "page_number": 2023},
        "7503": {"page_number": 2025, "file_type": "md"},
    }
    for doc_ref, metadata in rows.items():
        _index_nodes(
            backend,
            knowledge_id=knowledge_id,
            doc_ref=doc_ref,
            nodes=[
                TextNode(
                    text=f"shared keyword 元数据过滤 {doc_ref}",
                    metadata=dict(metadata),
                )
            ],
        )

    def matching(condition: dict) -> set[str]:
        return _doc_refs(
            _keyword_query(
                backend,
                knowledge_id=knowledge_id,
                query="shared keyword",
                metadata_condition=condition,
            )
        )

    assert matching(
        {
            "operator": "and",
            "conditions": [
                {"key": "file_name", "operator": "eq", "value": "tech.md"},
                {"key": "page_number", "operator": "eq", "value": 2024},
            ],
        }
    ) == {"7501"}
    assert matching(
        {
            "operator": "and",
            "conditions": [
                {"key": "page_number", "operator": "in", "value": [2023, 2024]}
            ],
        }
    ) == {"7501", "7502"}
    assert matching(
        {
            "operator": "and",
            "conditions": [{"key": "file_name", "operator": "==", "value": "tech.md"}],
        }
    ) == {"7501"}, "== is the documented alias of eq"
    assert matching(
        {
            "operator": "and",
            "conditions": [
                {"key": "heading_path", "operator": "eq", "value": 'a"b\\c'}
            ],
        }
    ) == {"7501"}, "quotes and backslashes survive the expression"
    assert matching(
        {
            "operator": "and",
            "conditions": [{"key": "file_type", "operator": "eq", "value": "md"}],
        }
    ) == {"7503"}, "a condition on a key only one row has still matches"
    assert (
        matching(
            {
                "operator": "and",
                "conditions": [
                    {"key": "file_name", "operator": "eq", "value": "missing.md"}
                ],
            }
        )
        == set()
    ), "a missing key never equals a value"

    rejected = [
        # Only a flat and is supported.
        {
            "operator": "or",
            "conditions": [{"key": "file_name", "operator": "eq", "value": "tech.md"}],
        },
        # Nested conditions are not part of the vocabulary.
        {
            "operator": "and",
            "conditions": [
                {
                    "operator": "and",
                    "conditions": [
                        {"key": "file_name", "operator": "eq", "value": "tech.md"}
                    ],
                }
            ],
        },
        # Operators outside eq/in are not compiled at all.
        {
            "operator": "and",
            "conditions": [{"key": "page_number", "operator": "gte", "value": 2024}],
        },
        {
            "operator": "and",
            "conditions": [
                {"key": "heading_path", "operator": "contains", "value": "a"}
            ],
        },
        # A key ingestion never writes cannot be filtered on.
        {
            "operator": "and",
            "conditions": [{"key": "category", "operator": "eq", "value": "tech"}],
        },
        # The condition shape itself has to be the supported one.
        {"doc_ref": "7501"},
    ]
    for condition in rejected:
        with pytest.raises(ValueError):
            matching(condition)


def test_keyword_on_a_legacy_dense_only_index_fails_loudly(
    milvus_env: MilvusContractEnv,
) -> None:
    """An index without the keyword capability never answers with empty hits.

    The capability is part of the contract, so this collection is built as an
    older contract would have declared it: the same physical schema, a stored
    schema version that is no longer current and no analyzer at all.
    """
    knowledge_id = milvus_env.new_knowledge_id()
    backend = milvus_env.backend()
    collection_name = backend.get_index_name(knowledge_id)
    legacy_contract = MilvusIndexBinding(
        collection_name=collection_name,
        connection=backend._store.connection_identity(),
        database=backend._store.db_name,
        schema_version=SCHEMA_VERSION - 1,
        embedding_space="sha256:legacy",
        dimension=DIMENSION,
        metric_type=METRIC_TYPE,
        index_type=INDEX_TYPE,
        analyzer="",
    )
    client = MilvusClient(uri=milvus_env.uri)
    try:
        schema = client.create_schema(
            auto_id=False,
            enable_dynamic_field=False,
            description=index_contract_description(legacy_contract),
        )
        schema.add_field("id", DataType.VARCHAR, is_primary=True, max_length=128)
        schema.add_field("knowledge_id", DataType.VARCHAR, max_length=512)
        schema.add_field("dense_vector", DataType.FLOAT_VECTOR, dim=DIMENSION)
        index_params = client.prepare_index_params()
        index_params.add_index(
            field_name="dense_vector",
            index_type="AUTOINDEX",
            metric_type="COSINE",
        )
        client.create_collection(
            collection_name=collection_name,
            schema=schema,
            index_params=index_params,
        )
        client.insert(
            collection_name=collection_name,
            data=[
                {
                    "id": "legacy-row",
                    "knowledge_id": knowledge_id,
                    "dense_vector": [1.0] + [0.0] * (DIMENSION - 1),
                }
            ],
        )
        client.flush(collection_name)

        with pytest.raises(IndexContractIncompatibleError):
            _keyword_query(backend, knowledge_id=knowledge_id, query="legacy")
        with pytest.raises(IndexContractIncompatibleError):
            backend.get_document(knowledge_id, "legacy-row")
        with pytest.raises(IndexContractIncompatibleError):
            backend.get_all_chunks(knowledge_id)

        assert client.has_collection(collection_name), "the index is never dropped"
        rows = client.query(
            collection_name=collection_name,
            filter='knowledge_id == "{}"'.format(knowledge_id),
            output_fields=["id"],
            limit=10,
            consistency_level="Strong",
        )
        assert [row["id"] for row in rows] == ["legacy-row"]
    finally:
        client.close()


def test_keyword_on_an_index_without_the_analyzer_fails_loudly(
    milvus_env: MilvusContractEnv,
) -> None:
    """The analyzer in the contract decides keyword capability, nothing else.

    The collection carries the current physical schema, so nothing in the row
    layout stops a keyword query; its contract declares no analyzer, which is
    exactly the older index whose Chinese BM25 answers would be silently empty.
    """
    from dataclasses import replace

    from knowledge_engine.embedding.space import compute_embedding_space

    knowledge_id = milvus_env.new_knowledge_id()
    backend = milvus_env.backend()
    collection_name = backend.get_index_name(knowledge_id)
    store = backend._store
    requested = store.build_binding(
        collection_name,
        dimension=DIMENSION,
        embedding_space=compute_embedding_space(DeterministicEmbedding(DIMENSION)),
    )

    with store.client() as client:
        store._create_collection(client, replace(requested, analyzer=""))

    with pytest.raises(IndexContractIncompatibleError) as failure:
        _keyword_query(backend, knowledge_id=knowledge_id, query="中文关键词")

    assert failure.value.code == "index_contract_incompatible"
    assert failure.value.details["analyzer"] == ""


def test_keyword_on_a_never_indexed_knowledge_base_creates_nothing(
    milvus_env: MilvusContractEnv,
) -> None:
    """An unknown knowledge base answers empty and creates no resources."""
    knowledge_id = milvus_env.new_knowledge_id()
    backend = milvus_env.backend()

    assert _keyword_query(backend, knowledge_id=knowledge_id, query="anything") == {
        "records": []
    }
    assert not milvus_env.has_collection(knowledge_id)


def test_keyword_of_a_dropped_index_reads_as_a_never_indexed_knowledge_base(
    milvus_env: MilvusContractEnv,
) -> None:
    """A dropped collection takes its contract with it.

    Keyword retrieval needs the contract to decide the analyzer, and the
    contract is stored in the collection, so a collection that is gone leaves
    nothing to check: the knowledge base reads as unindexed. A collection that
    replaced the index under the same name is refused instead (covered in
    ``test_milvus_index_failures``).
    """
    knowledge_id = milvus_env.new_knowledge_id()
    backend = _index_text_document(
        milvus_env,
        knowledge_id=knowledge_id,
        document_id=7701,
        text="临时文档，用于验证索引丢失的错误提示。",
    )
    client = MilvusClient(uri=milvus_env.uri)
    try:
        client.drop_collection(backend.get_index_name(knowledge_id))
    finally:
        client.close()

    assert _keyword_query(backend, knowledge_id=knowledge_id, query="临时文档") == {
        "records": []
    }


def _drop_shared_index(env: MilvusContractEnv, collection_name: str) -> None:
    """Drop the shared collection the rolling strategy created for a test."""
    client = MilvusClient(uri=env.uri)
    try:
        if client.has_collection(collection_name):
            client.drop_collection(collection_name)
    finally:
        client.close()
