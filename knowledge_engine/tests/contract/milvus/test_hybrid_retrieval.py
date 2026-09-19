# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Real-Milvus contract tests for weighted hybrid retrieval.

These tests drive the public backend entry point against a real Milvus 2.5.4
service and assert real fused results: a weight reversal must change which
document ranks first. Asserting the requested SDK parameters would pass even
if the weights were ignored, so every behavioural claim here is a hit or an
ordering produced by the server.
"""

from __future__ import annotations

import asyncio

import pytest
from llama_index.core.schema import TextNode
from pymilvus import MilvusClient

from knowledge_engine.embedding.space import derive_embedding_space_id
from knowledge_engine.query.executor import QueryExecutor
from knowledge_engine.storage.chunk_metadata import ChunkMetadata
from knowledge_engine.storage.milvus.backend import MilvusBackend
from knowledge_engine.storage.milvus.errors import IndexContractIncompatibleError
from shared.models import RetrievalScope

from .conftest import (
    MilvusContractEnv,
    await_document_visibility,
)

pytestmark = pytest.mark.milvus

DIMENSION = 8
# The dense branch prefers 8101 and the keyword branch prefers 8102.
DENSE_DOC = "8101"
KEYWORD_DOC = "8102"
DENSE_TEXT = "语义甲"
KEYWORD_TEXT = "关键词乙"
DENSE_QUERY_TEXT = "语义甲 query"
KEYWORD_QUERY_TEXT = "关键词乙 query"


def _normalized(vector: list[float]) -> list[float]:
    norm = sum(value * value for value in vector) ** 0.5
    return [value / norm for value in vector]


class ControlledEmbedding:
    """Deterministic vectors with an explicit per-text direction.

    The shared hash embedding gives both documents nearly identical
    directions, so the dense preference would not be a controlled input.
    Pinning the directions makes the dense branch clearly prefer one document
    while BM25 clearly prefers the other.
    """

    model_name = "contract-model"

    def __init__(self, vectors: dict[str, list[float]]):
        self._configured_dimension = DIMENSION
        self._vectors = {text: _normalized(v) for text, v in vectors.items()}
        # The storage contract binds an index to one embedding space, so this
        # double carries the identity the embedding factory would attach.
        self.embedding_space_id = derive_embedding_space_id(
            protocol="contract",
            model_id=self.model_name,
        )

    def get_query_embedding(self, query: str) -> list[float]:
        return list(self._vector_for(query.split("\n")[0]))

    def get_text_embedding_batch(self, texts, **kwargs):
        return [list(self._vector_for(text)) for text in texts]

    def _vector_for(self, text: str) -> list[float]:
        try:
            return self._vectors[text]
        except KeyError:
            return _normalized([1.0] * DIMENSION)


class EmbeddingBan:
    """Fails the test if a keyword endpoint reaches the embedding provider."""

    model_name = "contract-model"
    _configured_dimension = DIMENSION

    def get_query_embedding(self, query):
        raise AssertionError("a keyword endpoint must not build a query vector")

    def get_text_embedding_batch(self, texts, **kwargs):
        raise AssertionError("a keyword endpoint must not embed text")


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
    model,
) -> None:
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


def _query(
    backend: MilvusBackend,
    *,
    knowledge_id: str,
    query: str,
    model,
    mode: str = "hybrid",
    dense_query: str | None = None,
    top_k: int = 5,
    score_threshold: float = 0.0,
    scope: RetrievalScope | None = None,
    metadata_condition: dict | None = None,
    **weights,
) -> dict:
    executor = QueryExecutor(storage_backend=backend, embed_model=model)
    retrieval_config = {
        "top_k": top_k,
        "score_threshold": score_threshold,
        "retrieval_mode": mode,
        **weights,
    }
    query_plan = {"dense_query": dense_query} if dense_query else None
    return asyncio.run(
        executor.execute(
            knowledge_id=knowledge_id,
            query=query,
            query_plan=query_plan,
            retrieval_config=retrieval_config,
            scope=scope,
            metadata_condition=metadata_condition,
            user_id=1,
        )
    )


def _hybrid(
    backend,
    knowledge_id,
    embed_model,
    *,
    omit_default_weights: bool = False,
    **overrides,
) -> dict:
    """Run one hybrid query with the shared fixed query text and 0.5/0.5.

    The dense query text is a distinct constant, so the dense direction is an
    input of the test rather than a side effect of the keyword text. The
    embedding model is passed positionally so the ``**overrides`` a caller
    supplies can only carry retrieval settings such as the weights.
    """
    settings: dict = {
        "query": "zebra_pipeline_99",
        "dense_query": DENSE_QUERY_TEXT,
        "vector_weight": 0.5,
        "keyword_weight": 0.5,
    }
    if omit_default_weights:
        settings.pop("vector_weight")
        settings.pop("keyword_weight")
    settings.update(overrides)
    return _query(backend, knowledge_id=knowledge_id, model=embed_model, **settings)


def _doc_refs(result: dict) -> list[str]:
    return [record["metadata"]["doc_ref"] for record in result["records"]]


def _scores(result: dict) -> dict[str, float]:
    return {
        record["metadata"]["doc_ref"]: record["score"] for record in result["records"]
    }


@pytest.fixture(scope="module")
def preference_env(milvus_uri: str) -> MilvusContractEnv:
    """One isolated knowledge base and its model, shared by the module."""
    env = MilvusContractEnv(uri=milvus_uri)
    model = ControlledEmbedding(
        {
            DENSE_TEXT: [1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
            KEYWORD_TEXT: [0.71, 0.71, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
            # The query-side texts are separate constants so the dense
            # direction is pinned instead of derived from the document text.
            DENSE_QUERY_TEXT: [1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
            KEYWORD_QUERY_TEXT: [0.71, 0.71, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
        }
    )
    knowledge_id = env.new_knowledge_id()
    backend = env.backend()
    _index_nodes(
        backend,
        knowledge_id=knowledge_id,
        doc_ref=DENSE_DOC,
        model=model,
        nodes=[TextNode(text=DENSE_TEXT, metadata={"heading_path": "semantic"})],
    )
    _index_nodes(
        backend,
        knowledge_id=knowledge_id,
        doc_ref=KEYWORD_DOC,
        model=model,
        nodes=[
            TextNode(
                text=f"{KEYWORD_TEXT} zebra_pipeline_99",
                metadata={"heading_path": "keyword"},
            )
        ],
    )
    env.preference_model = model  # type: ignore[attr-defined]
    try:
        yield env
    finally:
        env.cleanup()


@pytest.fixture
def preference_index(
    preference_env: MilvusContractEnv,
) -> tuple[MilvusBackend, str, ControlledEmbedding]:
    return (
        preference_env.backend(),
        preference_env.created_knowledge_ids[0],
        preference_env.preference_model,  # type: ignore[attr-defined]
    )


def test_weight_reversal_changes_the_hybrid_ordering(preference_index) -> None:
    """Swapping 0.9/0.1 for 0.1/0.9 reverses the order of the fixed data."""
    backend, knowledge_id, model = preference_index

    vector_heavy = _hybrid(
        backend, knowledge_id, model, vector_weight=0.9, keyword_weight=0.1
    )
    keyword_heavy = _hybrid(
        backend, knowledge_id, model, vector_weight=0.1, keyword_weight=0.9
    )

    assert _doc_refs(vector_heavy) == [DENSE_DOC, KEYWORD_DOC]
    assert _doc_refs(keyword_heavy) == [KEYWORD_DOC, DENSE_DOC]


def test_default_hybrid_weights_fuse_both_branches(preference_index) -> None:
    """The product default 0.7/0.3 is a real fusion of both branches."""
    backend, knowledge_id, model = preference_index

    result = _query(
        backend,
        knowledge_id=knowledge_id,
        query="zebra_pipeline_99",
        dense_query=DENSE_QUERY_TEXT,
        model=model,
        mode="hybrid",
    )

    scores = _scores(result)
    assert set(scores) == {DENSE_DOC, KEYWORD_DOC}
    assert scores[KEYWORD_DOC] > 0.0, "the keyword share must reach the endpoint"
    assert _doc_refs(result)[0] == DENSE_DOC


def test_vector_endpoint_matches_pure_vector_retrieval(preference_index) -> None:
    """1/0 runs the dense branch alone and reports the raw cosine scores."""
    backend, knowledge_id, model = preference_index

    vector_only = _hybrid(
        backend, knowledge_id, model, vector_weight=1.0, keyword_weight=0.0
    )
    pure_vector = _query(
        backend,
        knowledge_id=knowledge_id,
        query="zebra_pipeline_99",
        dense_query=DENSE_QUERY_TEXT,
        model=model,
        mode="vector",
    )

    assert _doc_refs(vector_only) == _doc_refs(pure_vector)
    assert _scores(vector_only) == pytest.approx(_scores(pure_vector))


def test_keyword_endpoint_matches_pure_keyword_retrieval(preference_index) -> None:
    """0/1 answers from BM25 alone and never builds a query vector."""
    backend, knowledge_id, _ = preference_index

    keyword_only = _hybrid(
        backend,
        knowledge_id,
        EmbeddingBan(),
        vector_weight=0.0,
        keyword_weight=1.0,
    )
    pure_keyword = _query(
        backend,
        knowledge_id=knowledge_id,
        query="zebra_pipeline_99",
        model=EmbeddingBan(),
        mode="keyword",
    )

    assert _doc_refs(keyword_only) == _doc_refs(pure_keyword) == [KEYWORD_DOC]
    assert _scores(keyword_only) == pytest.approx(_scores(pure_keyword))
    assert _scores(keyword_only)[KEYWORD_DOC] > 0.4


def test_single_weight_takes_effect_and_pairs_with_its_complement(
    preference_index,
) -> None:
    """A lone keyword weight is honored and cannot fall back to the default."""
    backend, knowledge_id, model = preference_index

    at_0_3 = _hybrid(
        backend,
        knowledge_id,
        model,
        omit_default_weights=True,
        keyword_weight=0.3,
    )
    at_0_7 = _hybrid(
        backend,
        knowledge_id,
        model,
        omit_default_weights=True,
        keyword_weight=0.7,
    )
    low = _scores(at_0_3)[KEYWORD_DOC]
    high = _scores(at_0_7)[KEYWORD_DOC]

    # The two requests differ only in the lone keyword weight, and the partner
    # share is its complement, so the fused score must move once the weight is
    # actually consumed. The exact arithmetic is pinned by the adapter unit
    # tests; this asserts the real server consumed the setting.
    assert abs(high - low) >= 0.02
    assert high < low, "the larger keyword share must move this row"


def test_hybrid_threshold_cuts_the_reported_fusion_score(preference_index) -> None:
    """The threshold compares exactly the score the caller receives."""
    backend, knowledge_id, model = preference_index

    # The uncut run is the full candidate set with the scores the caller would
    # have received; every cut below must keep exactly the rows whose reported
    # score reaches it, at the same value.
    candidates = _hybrid(
        backend,
        knowledge_id,
        model,
        vector_weight=0.9,
        keyword_weight=0.1,
        score_threshold=0.0,
    )
    assert len(candidates["records"]) == 2

    for threshold in (0.2, 0.55, 0.7):
        filtered = _hybrid(
            backend,
            knowledge_id,
            model,
            vector_weight=0.9,
            keyword_weight=0.1,
            score_threshold=threshold,
        )
        expected = {
            doc_ref
            for doc_ref, score in _scores(candidates).items()
            if score >= threshold
        }
        assert set(_doc_refs(filtered)) == expected, threshold
        for record in filtered["records"]:
            assert record["score"] >= threshold
        for doc_ref in expected:
            assert _scores(filtered)[doc_ref] == pytest.approx(
                _scores(candidates)[doc_ref]
            )


def test_hybrid_respects_scope_and_metadata_filters(preference_index) -> None:
    """Both branches share one scope; out-of-scope rows never leak in."""
    backend, knowledge_id, model = preference_index

    scoped = _hybrid(
        backend,
        knowledge_id,
        model,
        scope=RetrievalScope(document_ids=[int(KEYWORD_DOC)]),
        metadata_condition={
            "operator": "and",
            "conditions": [
                {"key": "heading_path", "operator": "eq", "value": "keyword"}
            ],
        },
    )
    denied = _hybrid(
        backend,
        knowledge_id,
        model,
        scope=RetrievalScope(document_ids=[int(KEYWORD_DOC)]),
        metadata_condition={
            "operator": "and",
            "conditions": [
                {"key": "heading_path", "operator": "eq", "value": "semantic"}
            ],
        },
    )

    assert _doc_refs(scoped) == [KEYWORD_DOC]
    assert denied == {"records": []}


def test_hybrid_rejects_an_unsupported_metadata_operator(
    preference_index,
) -> None:
    """An operator outside the filter vocabulary fails on the hybrid path too."""
    backend, knowledge_id, model = preference_index

    with pytest.raises(ValueError):
        _hybrid(
            backend,
            knowledge_id,
            model,
            metadata_condition={
                "operator": "and",
                "conditions": [
                    {"key": "heading_path", "operator": "contains", "value": "50%off"}
                ],
            },
        )


def test_qa_pair_profile_promotes_vector_mode_to_hybrid(preference_index) -> None:
    """A QA profile runs Milvus hybrid and keeps the display text and identity."""
    backend, knowledge_id, model = preference_index

    result = asyncio.run(
        QueryExecutor(storage_backend=backend, embed_model=model).execute(
            knowledge_id=knowledge_id,
            query="zebra_pipeline_99",
            query_plan={
                "retrieval_profile": "qa_pair",
                "qa_pair_count": 3,
                "dense_query": DENSE_QUERY_TEXT,
                "sparse_query": "zebra_pipeline_99",
            },
            retrieval_config={
                "top_k": 5,
                "score_threshold": 0.0,
                "retrieval_mode": "vector",
            },
            user_id=1,
        )
    )

    scores = _scores(result)
    assert set(scores) == {DENSE_DOC, KEYWORD_DOC}
    # The policy ran hybrid, not the configured vector mode: the same request
    # with an explicit hybrid mode lands on the same 0.6/0.4 fusion, while the
    # vector mode alone drops the keyword-only document.
    explicit_hybrid = _hybrid(
        backend, knowledge_id, model, vector_weight=0.6, keyword_weight=0.4
    )
    assert scores == pytest.approx(_scores(explicit_hybrid))
    vector_mode = _query(
        backend,
        knowledge_id=knowledge_id,
        query="zebra_pipeline_99",
        dense_query=DENSE_QUERY_TEXT,
        model=model,
        mode="vector",
    )
    assert scores[KEYWORD_DOC] != pytest.approx(_scores(vector_mode)[KEYWORD_DOC])
    for record in result["records"]:
        assert record["content"] == record["metadata"]["display_text"]
        assert (
            record["metadata"]["doc_ref"] == record["title"].split("-")[1].split(".")[0]
        )


def test_hybrid_never_adopts_a_collection_that_replaced_the_index(
    preference_env: MilvusContractEnv,
) -> None:
    """A foreign collection under the index name is refused, not searched.

    The contract lives in the collection (ticket 12), so an index that was
    dropped outside the product leaves nothing behind to detect; a collection
    that answers under the index name while declaring no contract of ours stays
    detectable, and hybrid retrieval must refuse it instead of searching rows
    it cannot describe.
    """
    knowledge_id = preference_env.new_knowledge_id()
    backend = preference_env.backend()
    model = preference_env.preference_model  # type: ignore[attr-defined]
    _index_nodes(
        backend,
        knowledge_id=knowledge_id,
        doc_ref="8301",
        model=model,
        nodes=[TextNode(text=DENSE_TEXT, metadata={"heading_path": "semantic"})],
    )
    client = MilvusClient(uri=backend.url)
    try:
        client.drop_collection(backend.get_index_name(knowledge_id))
        client.create_collection(
            collection_name=backend.get_index_name(knowledge_id),
            dimension=DIMENSION,
        )
    finally:
        client.close()

    with pytest.raises(IndexContractIncompatibleError):
        _hybrid(backend, knowledge_id, model)


def test_hybrid_rejects_weights_outside_the_share_range() -> None:
    """Out-of-range weights fail loudly instead of being clamped or ignored."""
    from pydantic import ValidationError

    from shared.models import RuntimeRetrievalConfig

    for weights in (
        {"vector_weight": -0.1, "keyword_weight": 1.1},
        {"vector_weight": 1.5, "keyword_weight": 0.5},
    ):
        with pytest.raises(ValidationError):
            RuntimeRetrievalConfig(retrieval_mode="hybrid", **weights)


def test_hybrid_rejects_non_finite_and_double_zero_weights(preference_index) -> None:
    """The storage boundary rejects a request the config model cannot express."""
    backend, knowledge_id, model = preference_index

    for weights in (
        {"vector_weight": float("nan"), "keyword_weight": 0.5},
        {"vector_weight": 0.4, "keyword_weight": float("inf")},
        {"vector_weight": 0.0, "keyword_weight": 0.0},
    ):
        with pytest.raises(ValueError):
            _hybrid(backend, knowledge_id, model, **weights)


def test_default_weights_pass_a_preset_positive_example(preference_index) -> None:
    """The default 0.7/0.3 settings clear a non-zero preset threshold."""
    backend, knowledge_id, model = preference_index

    result = _query(
        backend,
        knowledge_id=knowledge_id,
        query="zebra_pipeline_99",
        dense_query=DENSE_QUERY_TEXT,
        model=model,
        mode="hybrid",
        score_threshold=0.5,
    )

    # Default weights and a real cut rather than a threshold of zero.
    assert _doc_refs(result)[0] == DENSE_DOC
    assert _scores(result)[DENSE_DOC] >= 0.5


def test_hybrid_filters_before_the_candidate_cut(milvus_env: MilvusContractEnv) -> None:
    """A matching row behind many others is still recalled within ``top_k``."""
    knowledge_id = milvus_env.new_knowledge_id()
    backend = milvus_env.backend()
    model = ControlledEmbedding(
        {
            DENSE_TEXT: [1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
            DENSE_QUERY_TEXT: [1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
        }
    )
    # Enough filler rows to fill both routes' ``top_k`` several times over, so
    # only a filter applied before the candidate cut can surface the target.
    _index_nodes(
        backend,
        knowledge_id=knowledge_id,
        doc_ref="8501",
        model=model,
        nodes=[
            TextNode(
                text="alpha " * 20 + f"filler chunk {index}",
                metadata={"heading_path": "filler", "chunk_index": index},
            )
            for index in range(60)
        ],
    )
    _index_nodes(
        backend,
        knowledge_id=knowledge_id,
        doc_ref="8502",
        model=model,
        nodes=[TextNode(text="alpha", metadata={"heading_path": "target"})],
    )

    unfiltered = _hybrid(backend, knowledge_id, model, query="alpha", top_k=5)
    assert set(_doc_refs(unfiltered)) == {"8501"}, "filler rows outrank the target"

    filtered = _hybrid(
        backend,
        knowledge_id,
        model,
        query="alpha",
        top_k=5,
        metadata_condition={
            "operator": "and",
            "conditions": [
                {"key": "heading_path", "operator": "eq", "value": "target"}
            ],
        },
    )
    assert _doc_refs(filtered) == ["8502"]
    assert len(filtered["records"]) <= 5
