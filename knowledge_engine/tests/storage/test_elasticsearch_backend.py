# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for ElasticsearchBackend get_all_chunks and purge/drop behavior."""

from unittest.mock import MagicMock, patch

import pytest
from llama_index.core.schema import TextNode
from llama_index.core.vector_stores.utils import node_to_metadata_dict

from shared.models import RetrievalScope


class TestHybridAlphaResolution:
    @patch("knowledge_engine.storage.elasticsearch_backend.Elasticsearch")
    def test_resolve_hybrid_alpha_prefers_normalized_pair(self, mock_client_class):
        from knowledge_engine.storage.elasticsearch_backend import ElasticsearchBackend

        mock_client = MagicMock()
        mock_client_class.return_value = mock_client

        backend = ElasticsearchBackend(
            {
                "url": "http://localhost:9200",
                "indexStrategy": {"mode": "per_dataset", "prefix": "test"},
            }
        )

        assert backend._resolve_hybrid_alpha(
            {"vector_weight": 2.0, "keyword_weight": 1.0}
        ) == pytest.approx(2 / 3)

    @patch("knowledge_engine.storage.elasticsearch_backend.Elasticsearch")
    def test_resolve_hybrid_alpha_uses_vector_weight_when_only_vector_is_present(
        self, mock_client_class
    ):
        from knowledge_engine.storage.elasticsearch_backend import ElasticsearchBackend

        mock_client = MagicMock()
        mock_client_class.return_value = mock_client

        backend = ElasticsearchBackend(
            {
                "url": "http://localhost:9200",
                "indexStrategy": {"mode": "per_dataset", "prefix": "test"},
            }
        )

        assert backend._resolve_hybrid_alpha({"vector_weight": 0.8}) == pytest.approx(
            0.8
        )

    @patch("knowledge_engine.storage.elasticsearch_backend.Elasticsearch")
    def test_resolve_hybrid_alpha_uses_keyword_weight_when_only_keyword_is_present(
        self, mock_client_class
    ):
        from knowledge_engine.storage.elasticsearch_backend import ElasticsearchBackend

        mock_client = MagicMock()
        mock_client_class.return_value = mock_client

        backend = ElasticsearchBackend(
            {
                "url": "http://localhost:9200",
                "indexStrategy": {"mode": "per_dataset", "prefix": "test"},
            }
        )

        assert backend._resolve_hybrid_alpha({"keyword_weight": 0.2}) == pytest.approx(
            0.8
        )


class TestRetrieveSearchHints:
    @patch("knowledge_engine.storage.elasticsearch_backend.Elasticsearch")
    def test_an_absent_threshold_uses_the_engine_default(
        self, mock_client_class: MagicMock
    ) -> None:
        """An absent score_threshold falls back to 0.7 on the ES read path."""
        from knowledge_engine.storage.elasticsearch_backend import ElasticsearchBackend

        mock_client_class.return_value = MagicMock()
        backend = ElasticsearchBackend(
            {
                "url": "http://localhost:9200",
                "indexStrategy": {"mode": "per_dataset", "prefix": "test"},
            }
        )
        vector_store = MagicMock()
        vector_store.query.return_value = MagicMock(
            nodes=[TextNode(text="high"), TextNode(text="low")],
            # ES knn scores for cosines 0.81 and 0.62.
            similarities=[0.905, 0.81],
        )
        backend.create_vector_store = MagicMock(return_value=vector_store)
        embed_model = MagicMock()
        embed_model.get_query_embedding.return_value = [0.1, 0.2]

        result = backend.retrieve(
            knowledge_id="kb_1",
            query="release checklist",
            embed_model=embed_model,
            retrieval_setting={"top_k": 5, "retrieval_mode": "vector"},
        )

        assert [record["score"] for record in result["records"]] == pytest.approx(
            [0.81]
        )

    @patch("knowledge_engine.storage.elasticsearch_backend.Elasticsearch")
    def test_an_explicit_zero_threshold_is_not_replaced(
        self, mock_client_class: MagicMock
    ) -> None:
        """An explicitly configured zero keeps every candidate."""
        from knowledge_engine.storage.elasticsearch_backend import ElasticsearchBackend

        mock_client_class.return_value = MagicMock()
        backend = ElasticsearchBackend(
            {
                "url": "http://localhost:9200",
                "indexStrategy": {"mode": "per_dataset", "prefix": "test"},
            }
        )
        vector_store = MagicMock()
        vector_store.query.return_value = MagicMock(
            nodes=[TextNode(text="high"), TextNode(text="low")],
            # ES knn scores for cosines 0.81 and 0.62.
            similarities=[0.905, 0.81],
        )
        backend.create_vector_store = MagicMock(return_value=vector_store)
        embed_model = MagicMock()
        embed_model.get_query_embedding.return_value = [0.1, 0.2]

        result = backend.retrieve(
            knowledge_id="kb_1",
            query="release checklist",
            embed_model=embed_model,
            retrieval_setting={
                "top_k": 5,
                "score_threshold": 0,
                "retrieval_mode": "vector",
            },
        )

        assert [record["score"] for record in result["records"]] == pytest.approx(
            [0.81, 0.62]
        )

    @patch("knowledge_engine.storage.elasticsearch_backend.Elasticsearch")
    def test_process_query_results_returns_display_text(self, mock_client_class):
        from knowledge_engine.storage.elasticsearch_backend import ElasticsearchBackend

        mock_client_class.return_value = MagicMock()
        backend = ElasticsearchBackend(
            {
                "url": "http://localhost:9200",
                "indexStrategy": {"mode": "per_dataset", "prefix": "test"},
            }
        )
        node = TextNode(
            text="Question-only retrieval text",
            metadata={"display_text": "Q: question\n\nA: full answer"},
        )

        result = backend._process_query_results(
            MagicMock(nodes=[node], similarities=[0.9]),
            score_threshold=0.1,
            retrieval_mode="vector",
        )

        assert result["records"][0]["content"] == "Q: question\n\nA: full answer"

    @patch("knowledge_engine.storage.elasticsearch_backend.Elasticsearch")
    def test_retrieve_rejects_doc_ref_in_metadata_condition(self, mock_client_class):
        from knowledge_engine.storage.elasticsearch_backend import ElasticsearchBackend

        mock_client = MagicMock()
        mock_client_class.return_value = mock_client

        backend = ElasticsearchBackend(
            {
                "url": "http://localhost:9200",
                "indexStrategy": {"mode": "per_dataset", "prefix": "test"},
            }
        )

        with pytest.raises(ValueError, match=r"RetrievalScope\.document_ids"):
            backend.retrieve(
                knowledge_id="kb_1",
                query="release checklist",
                embed_model=MagicMock(),
                retrieval_setting={
                    "top_k": 5,
                    "score_threshold": 0.2,
                    "retrieval_mode": "vector",
                },
                metadata_condition={
                    "operator": "and",
                    "conditions": [
                        {"key": "doc_ref", "operator": "in", "value": ["10"]}
                    ],
                },
            )

    @patch("knowledge_engine.storage.elasticsearch_backend.Elasticsearch")
    def test_retrieve_vector_mode_adds_document_scope_terms_filter(
        self, mock_client_class
    ):
        from knowledge_engine.storage.elasticsearch_backend import ElasticsearchBackend

        mock_client = MagicMock()
        mock_client_class.return_value = mock_client

        backend = ElasticsearchBackend(
            {
                "url": "http://localhost:9200",
                "indexStrategy": {"mode": "per_dataset", "prefix": "test"},
            }
        )
        mock_store = MagicMock()
        mock_store.query.return_value = MagicMock(nodes=[], similarities=[])
        backend.create_vector_store = MagicMock(return_value=mock_store)

        embed_model = MagicMock()
        embed_model.get_query_embedding.return_value = [0.1, 0.2, 0.3]

        backend.retrieve(
            knowledge_id="kb_1",
            query="release checklist",
            embed_model=embed_model,
            retrieval_setting={
                "top_k": 5,
                "score_threshold": 0.2,
                "retrieval_mode": "vector",
            },
            scope=RetrievalScope(document_ids=[10, 11]),
        )

        custom_query = mock_store.query.call_args.kwargs["custom_query"]
        query_body = custom_query({"query": {"match_all": {}}}, None)
        assert query_body["query"]["bool"]["must"] == [{"match_all": {}}]
        assert query_body["query"]["bool"]["filter"] == [
            {"term": {"metadata.knowledge_id.keyword": "kb_1"}},
            {"terms": {"metadata.doc_ref.keyword": ["10", "11"]}},
        ]
        vs_query = mock_store.query.call_args.args[0]
        assert vs_query.filters is None

    @patch("knowledge_engine.storage.elasticsearch_backend.Elasticsearch")
    def test_retrieve_vector_mode_preserves_single_bool_filter_when_merging_scope(
        self, mock_client_class
    ):
        from knowledge_engine.storage.elasticsearch_backend import ElasticsearchBackend

        mock_client = MagicMock()
        mock_client_class.return_value = mock_client

        backend = ElasticsearchBackend(
            {
                "url": "http://localhost:9200",
                "indexStrategy": {"mode": "per_dataset", "prefix": "test"},
            }
        )
        mock_store = MagicMock()
        mock_store.query.return_value = MagicMock(nodes=[], similarities=[])
        backend.create_vector_store = MagicMock(return_value=mock_store)

        embed_model = MagicMock()
        embed_model.get_query_embedding.return_value = [0.1, 0.2, 0.3]

        backend.retrieve(
            knowledge_id="kb_1",
            query="release checklist",
            embed_model=embed_model,
            retrieval_setting={
                "top_k": 5,
                "score_threshold": 0.2,
                "retrieval_mode": "vector",
            },
            scope=RetrievalScope(document_ids=[10]),
        )

        custom_query = mock_store.query.call_args.kwargs["custom_query"]
        query_body = custom_query(
            {
                "query": {
                    "bool": {
                        "must": [{"match": {"content": "release"}}],
                        "filter": {"term": {"metadata.existing.keyword": "value"}},
                    }
                }
            },
            None,
        )

        assert query_body["query"]["bool"]["filter"] == [
            {"term": {"metadata.existing.keyword": "value"}},
            {"term": {"metadata.knowledge_id.keyword": "kb_1"}},
            {"terms": {"metadata.doc_ref.keyword": ["10"]}},
        ]

    @patch("knowledge_engine.storage.elasticsearch_backend.Elasticsearch")
    def test_retrieve_vector_mode_adds_document_scope_to_knn_filter(
        self, mock_client_class
    ):
        from knowledge_engine.storage.elasticsearch_backend import ElasticsearchBackend

        mock_client = MagicMock()
        mock_client_class.return_value = mock_client

        backend = ElasticsearchBackend(
            {
                "url": "http://localhost:9200",
                "indexStrategy": {"mode": "per_dataset", "prefix": "test"},
            }
        )
        mock_store = MagicMock()
        mock_store.query.return_value = MagicMock(nodes=[], similarities=[])
        backend.create_vector_store = MagicMock(return_value=mock_store)

        embed_model = MagicMock()
        embed_model.get_query_embedding.return_value = [0.1, 0.2, 0.3]

        backend.retrieve(
            knowledge_id="kb_1",
            query="release checklist",
            embed_model=embed_model,
            retrieval_setting={
                "top_k": 5,
                "score_threshold": 0.2,
                "retrieval_mode": "vector",
            },
            scope=RetrievalScope(document_ids=[10, 11]),
        )

        custom_query = mock_store.query.call_args.kwargs["custom_query"]
        query_body = custom_query(
            {
                "knn": {
                    "field": "embedding",
                    "filter": [
                        {"term": {"metadata.existing.keyword": "value"}},
                    ],
                }
            },
            None,
        )
        assert query_body["knn"]["filter"] == [
            {"term": {"metadata.existing.keyword": "value"}},
            {"term": {"metadata.knowledge_id.keyword": "kb_1"}},
            {"terms": {"metadata.doc_ref.keyword": ["10", "11"]}},
        ]

    @patch("knowledge_engine.storage.elasticsearch_backend.Elasticsearch")
    def test_retrieve_vector_mode_scope_only_keeps_query_body_knn_only(
        self, mock_client_class
    ):
        from knowledge_engine.storage.elasticsearch_backend import ElasticsearchBackend

        mock_client = MagicMock()
        mock_client_class.return_value = mock_client

        backend = ElasticsearchBackend(
            {
                "url": "http://localhost:9200",
                "indexStrategy": {"mode": "per_dataset", "prefix": "test"},
            }
        )
        mock_store = MagicMock()
        mock_store.query.return_value = MagicMock(nodes=[], similarities=[])
        backend.create_vector_store = MagicMock(return_value=mock_store)

        embed_model = MagicMock()
        embed_model.get_query_embedding.return_value = [0.1, 0.2, 0.3]

        backend.retrieve(
            knowledge_id="kb_1",
            query="release checklist",
            embed_model=embed_model,
            retrieval_setting={
                "top_k": 5,
                "score_threshold": 0.2,
                "retrieval_mode": "vector",
            },
            scope=RetrievalScope(document_ids=[10, 11]),
        )

        custom_query = mock_store.query.call_args.kwargs["custom_query"]
        query_body = custom_query({"knn": {"field": "embedding"}}, None)
        assert "query" not in query_body
        assert query_body["knn"]["filter"] == [
            {"term": {"metadata.knowledge_id.keyword": "kb_1"}},
            {"terms": {"metadata.doc_ref.keyword": ["10", "11"]}},
        ]

    @patch("knowledge_engine.storage.elasticsearch_backend.Elasticsearch")
    def test_retrieve_vector_mode_keeps_knowledge_id_outside_metadata_or(
        self, mock_client_class
    ):
        from knowledge_engine.storage.elasticsearch_backend import ElasticsearchBackend

        mock_client = MagicMock()
        mock_client_class.return_value = mock_client

        backend = ElasticsearchBackend(
            {
                "url": "http://localhost:9200",
                "indexStrategy": {"mode": "per_dataset", "prefix": "test"},
            }
        )
        mock_store = MagicMock()
        mock_store.query.return_value = MagicMock(nodes=[], similarities=[])
        backend.create_vector_store = MagicMock(return_value=mock_store)

        embed_model = MagicMock()
        embed_model.get_query_embedding.return_value = [0.1, 0.2, 0.3]

        backend.retrieve(
            knowledge_id="kb_1",
            query="release checklist",
            embed_model=embed_model,
            retrieval_setting={
                "top_k": 5,
                "score_threshold": 0.2,
                "retrieval_mode": "vector",
            },
            metadata_condition={
                "operator": "or",
                "conditions": [
                    {"key": "lang", "operator": "==", "value": "zh"},
                    {"key": "source", "operator": "==", "value": "manual"},
                ],
            },
        )

        custom_query = mock_store.query.call_args.kwargs["custom_query"]
        query_body = custom_query({"knn": {"field": "embedding"}}, None)
        assert query_body["knn"]["filter"] == [
            {"term": {"metadata.knowledge_id.keyword": "kb_1"}},
            {
                "bool": {
                    "should": [
                        {"term": {"metadata.lang.keyword": "zh"}},
                        {"term": {"metadata.source.keyword": "manual"}},
                    ],
                    "minimum_should_match": 1,
                }
            },
        ]
        vs_query = mock_store.query.call_args.args[0]
        assert vs_query.filters is None

    @patch("knowledge_engine.storage.elasticsearch_backend.Elasticsearch")
    def test_retrieve_hybrid_mode_uses_dense_and_sparse_hints(self, mock_client_class):
        from knowledge_engine.storage.elasticsearch_backend import ElasticsearchBackend

        mock_client = MagicMock()
        mock_client_class.return_value = mock_client

        backend = ElasticsearchBackend(
            {
                "url": "http://localhost:9200",
                "indexStrategy": {"mode": "per_dataset", "prefix": "test"},
            }
        )
        mock_store = MagicMock()
        mock_store.query.return_value = MagicMock(nodes=[], similarities=[])
        backend.create_vector_store = MagicMock(return_value=mock_store)

        embed_model = MagicMock()
        embed_model.get_query_embedding.return_value = [0.1, 0.2, 0.3]

        backend.retrieve(
            knowledge_id="kb_1",
            query="release checklist",
            embed_model=embed_model,
            retrieval_setting={
                "top_k": 5,
                "score_threshold": 0.2,
                "retrieval_mode": "hybrid",
                "search_hints": {
                    "semantic_query": "How to verify the release checklist?",
                    "keywords": ["release"],
                    "phrases": ["release checklist"],
                },
            },
        )

        embed_model.get_query_embedding.assert_called_once_with(
            "How to verify the release checklist?"
        )
        vs_query = mock_store.query.call_args.args[0]
        assert vs_query.query_str == '"release checklist" release'
        custom_query = mock_store.query.call_args.kwargs["custom_query"]
        query_body = custom_query(
            {
                "query": {
                    "bool": {"filter": [{"term": {"metadata.knowledge_id": "kb_1"}}]}
                }
            },
            None,
        )
        assert query_body["query"]["bool"]["minimum_should_match"] == 1
        assert query_body["query"]["bool"]["filter"] == [
            {"term": {"metadata.knowledge_id": "kb_1"}},
            {"term": {"metadata.knowledge_id.keyword": "kb_1"}},
        ]
        assert query_body["query"]["bool"]["should"] == [
            {"match_phrase": {"content": {"query": "release checklist", "boost": 3.0}}},
            {"match": {"content": {"query": "release", "boost": 1.0}}},
        ]

    @patch("knowledge_engine.storage.elasticsearch_backend.Elasticsearch")
    def test_retrieve_keyword_mode_uses_phrase_aware_sparse_query(
        self, mock_client_class
    ):
        from knowledge_engine.storage.elasticsearch_backend import ElasticsearchBackend

        mock_client = MagicMock()
        mock_client_class.return_value = mock_client

        backend = ElasticsearchBackend(
            {
                "url": "http://localhost:9200",
                "indexStrategy": {"mode": "per_dataset", "prefix": "test"},
            }
        )
        mock_store = MagicMock()
        mock_store.query.return_value = MagicMock(nodes=[], similarities=[])
        backend.create_vector_store = MagicMock(return_value=mock_store)

        backend.retrieve(
            knowledge_id="kb_1",
            query="release checklist",
            embed_model=MagicMock(),
            retrieval_setting={
                "top_k": 5,
                "score_threshold": 0.2,
                "retrieval_mode": "keyword",
                "search_hints": {
                    "keywords": ["release"],
                    "phrases": ["release checklist"],
                },
            },
        )

        vs_query = mock_store.query.call_args.args[0]
        assert vs_query.query_str == '"release checklist" release'
        custom_query = mock_store.query.call_args.kwargs["custom_query"]
        query_body = custom_query({"query": {"bool": {"filter": []}}}, None)
        assert query_body["query"]["bool"]["minimum_should_match"] == 1
        assert query_body["query"]["bool"]["should"] == [
            {"match_phrase": {"content": {"query": "release checklist", "boost": 3.0}}},
            {"match": {"content": {"query": "release", "boost": 1.0}}},
        ]


class TestRelativeScoreProcessing:
    """Keyword and hybrid scores are rescaled to the result set's maximum."""

    def _backend(self, mock_client_class: MagicMock):
        from knowledge_engine.storage.elasticsearch_backend import ElasticsearchBackend

        mock_client_class.return_value = MagicMock()
        return ElasticsearchBackend(
            {
                "url": "http://localhost:9200",
                "indexStrategy": {"mode": "per_dataset", "prefix": "test"},
            }
        )

    @patch("knowledge_engine.storage.elasticsearch_backend.Elasticsearch")
    def test_keyword_scores_are_rescaled_before_the_threshold(
        self, mock_client_class: MagicMock
    ) -> None:
        backend = self._backend(mock_client_class)

        result = backend._process_query_results(
            MagicMock(
                nodes=[TextNode(text="top hit"), TextNode(text="weak hit")],
                similarities=[6.0, 4.2],
            ),
            score_threshold=0.7,
            retrieval_mode="keyword",
        )

        assert [record["score"] for record in result["records"]] == pytest.approx(
            [1.0, 0.7]
        )

    @patch("knowledge_engine.storage.elasticsearch_backend.Elasticsearch")
    def test_hybrid_scores_are_rescaled_even_when_the_top_is_below_one(
        self, mock_client_class: MagicMock
    ) -> None:
        """A 0.68 top hit still reports 1.0, not itself."""
        backend = self._backend(mock_client_class)

        result = backend._process_query_results(
            MagicMock(nodes=[TextNode(text="top hit")], similarities=[0.68]),
            score_threshold=0.7,
            retrieval_mode="hybrid",
        )

        assert [record["score"] for record in result["records"]] == pytest.approx([1.0])

    @patch("knowledge_engine.storage.elasticsearch_backend.Elasticsearch")
    def test_vector_scores_are_the_cosine_behind_the_knn_score(
        self, mock_client_class: MagicMock
    ) -> None:
        """The store reports the knn score; the backend inverts it to cosine."""
        backend = self._backend(mock_client_class)

        result = backend._process_query_results(
            MagicMock(nodes=[TextNode(text="top hit")], similarities=[0.9]),
            score_threshold=0.0,
            retrieval_mode="vector",
        )

        # ES computes the knn score as (1 + cosine) / 2.
        assert [record["score"] for record in result["records"]] == pytest.approx([0.8])


class _FakeElasticsearch:
    """Stands in for the external Elasticsearch service only.

    The real LlamaIndex store and its retrieval strategies run on top of it, so
    the tests below exercise the whole adapter chain instead of a hand-built
    ``VectorStoreQueryResult``.
    """

    def __init__(self, hits: list[dict]) -> None:
        self.hits = hits

    def options(self, **kwargs: object) -> "_FakeElasticsearch":
        return self

    async def search(self, **kwargs: object) -> dict:
        return {"hits": {"hits": self.hits}}

    async def close(self) -> None:
        return None


def _es_hits(scored_texts: list[tuple[float, str]]) -> list[dict]:
    """Build the hits one Elasticsearch response carries, scores included."""
    hits: list[dict] = []
    for position, (score, text) in enumerate(scored_texts):
        node = TextNode(text=text)
        hits.append(
            {
                "_index": "index_kb_1",
                "_id": f"node-{position}",
                "_score": score,
                "_source": {
                    "content": text,
                    "metadata": node_to_metadata_dict(node, remove_text=True),
                },
            }
        )
    return hits


def _retrieve_through_store(
    hits: list[dict], retrieval_mode: str, *, score_threshold: float
) -> dict:
    """Drive one query through production wiring with only ES itself faked."""
    from knowledge_engine.storage.elasticsearch_backend import ElasticsearchBackend

    backend = ElasticsearchBackend(
        {
            "url": "http://localhost:9200",
            "indexStrategy": {"mode": "per_dataset", "prefix": "test"},
        }
    )
    embed_model = MagicMock()
    embed_model.get_query_embedding.return_value = [0.1, 0.2]

    with patch(
        "llama_index.vector_stores.elasticsearch.base.get_elasticsearch_client",
        return_value=_FakeElasticsearch(hits),
    ):
        return backend.retrieve(
            knowledge_id="kb_1",
            query="release checklist",
            embed_model=embed_model,
            retrieval_setting={
                "top_k": 5,
                "retrieval_mode": retrieval_mode,
                "score_threshold": score_threshold,
            },
        )


class TestRawScoreChain:
    """Score semantics through the real Elasticsearch adapter chain."""

    def test_keyword_chain_keeps_the_raw_bm25_ratio(self) -> None:
        """Raw [6.0, 4.2] must survive the adapter as [1.0, 0.7]."""
        result = _retrieve_through_store(
            _es_hits([(6.0, "relevant"), (4.2, "boundary")]),
            "keyword",
            score_threshold=0.7,
        )

        assert [record["content"] for record in result["records"]] == [
            "relevant",
            "boundary",
        ]
        assert [record["score"] for record in result["records"]] == pytest.approx(
            [1.0, 0.7]
        )

    def test_hybrid_chain_keeps_the_raw_fused_ratio(self) -> None:
        result = _retrieve_through_store(
            _es_hits([(6.0, "relevant"), (4.2, "boundary")]),
            "hybrid",
            score_threshold=0.7,
        )

        assert [record["score"] for record in result["records"]] == pytest.approx(
            [1.0, 0.7]
        )

    def test_keyword_single_hit_normalizes_to_one(self) -> None:
        result = _retrieve_through_store(
            _es_hits([(6.0, "only")]),
            "keyword",
            score_threshold=0.7,
        )

        assert [record["score"] for record in result["records"]] == pytest.approx([1.0])

    def test_vector_chain_reports_raw_cosine_instead_of_the_knn_score(self) -> None:
        """ES knn scores 0.9 and 0.55 are cosines 0.8 and 0.1."""
        result = _retrieve_through_store(
            _es_hits([(0.9, "high"), (0.55, "low")]),
            "vector",
            score_threshold=0.0,
        )

        assert [record["score"] for record in result["records"]] == pytest.approx(
            [0.8, 0.1]
        )

    def test_vector_threshold_compares_raw_cosine(self) -> None:
        result = _retrieve_through_store(
            _es_hits([(0.9, "high"), (0.7, "low")]),
            "vector",
            score_threshold=0.5,
        )

        assert [record["content"] for record in result["records"]] == ["high"]
        assert result["records"][0]["score"] == pytest.approx(0.8)

    def test_vector_scores_do_not_scale_with_the_candidate_set(self) -> None:
        alone = _retrieve_through_store(
            _es_hits([(0.9, "high")]),
            "vector",
            score_threshold=0.0,
        )
        with_companion = _retrieve_through_store(
            _es_hits([(0.9, "high"), (0.55, "low")]),
            "vector",
            score_threshold=0.0,
        )

        assert alone["records"][0]["score"] == pytest.approx(
            with_companion["records"][0]["score"]
        )

    def test_recording_store_forwards_vendor_attribute_writes(self) -> None:
        """The vendor add path sets num_dimensions through the wrapper."""
        from knowledge_engine.storage.elasticsearch_store import _HitScoreRecorder

        inner = MagicMock()
        recorder = _HitScoreRecorder(inner, [])

        recorder.num_dimensions = 3

        assert inner.num_dimensions == 3


class TestGetAllChunks:
    """Tests for ElasticsearchBackend.get_all_chunks."""

    @patch("knowledge_engine.storage.elasticsearch_backend.Elasticsearch")
    def test_get_all_chunks_returns_parsed_chunks(self, mock_client_class):
        """Should parse hits into normalized chunk payloads."""
        from knowledge_engine.storage.elasticsearch_backend import ElasticsearchBackend

        mock_client = MagicMock()
        mock_client_class.return_value = mock_client
        mock_client.indices.exists.return_value = True
        mock_client.search.return_value = {
            "hits": {
                "total": {"value": 1, "relation": "eq"},
                "hits": [
                    {
                        "_source": {
                            "content": "chunk content",
                            "metadata": {
                                "source_file": "doc-a.md",
                                "chunk_index": 3,
                                "doc_ref": "doc_1",
                                "knowledge_id": "kb_1",
                            },
                        }
                    }
                ],
            }
        }

        backend = ElasticsearchBackend(
            {
                "url": "http://localhost:9200",
                "indexStrategy": {"mode": "per_dataset", "prefix": "test"},
            }
        )

        result = backend.get_all_chunks(knowledge_id="kb_1", max_chunks=100)
        assert len(result) == 1
        assert result[0]["doc_ref"] == "doc_1"
        assert result[0]["chunk_id"] == 3

    @patch("knowledge_engine.storage.elasticsearch_backend.Elasticsearch")
    def test_get_all_chunks_returns_empty_when_no_hits(self, mock_client_class):
        """Should return an empty list when the knowledge_id term query has no hits."""
        from knowledge_engine.storage.elasticsearch_backend import ElasticsearchBackend

        mock_client = MagicMock()
        mock_client_class.return_value = mock_client
        mock_client.indices.exists.return_value = True
        mock_client.search.return_value = {
            "hits": {"total": {"value": 0, "relation": "eq"}, "hits": []}
        }

        backend = ElasticsearchBackend(
            {
                "url": "http://localhost:9200",
                "indexStrategy": {"mode": "per_dataset", "prefix": "test"},
            }
        )

        result = backend.get_all_chunks(knowledge_id="kb_1", max_chunks=100)
        assert result == []

    @patch("knowledge_engine.storage.elasticsearch_backend.Elasticsearch")
    def test_get_all_chunks_applies_metadata_condition(self, mock_client_class):
        from knowledge_engine.storage.elasticsearch_backend import ElasticsearchBackend

        mock_client = MagicMock()
        mock_client_class.return_value = mock_client
        mock_client.indices.exists.return_value = True
        mock_client.search.return_value = {
            "hits": {
                "total": {"value": 2, "relation": "eq"},
                "hits": [
                    {
                        "_source": {
                            "content": "chunk content",
                            "metadata": {
                                "source_file": "doc-a.md",
                                "chunk_index": 3,
                                "doc_ref": "doc_1",
                                "knowledge_id": "kb_1",
                                "lang": "zh",
                            },
                        }
                    },
                    {
                        "_source": {
                            "content": "chunk content",
                            "metadata": {
                                "source_file": "doc-b.md",
                                "chunk_index": 4,
                                "doc_ref": "doc_2",
                                "knowledge_id": "kb_1",
                                "lang": "en",
                            },
                        }
                    },
                ],
            }
        }

        backend = ElasticsearchBackend(
            {
                "url": "http://localhost:9200",
                "indexStrategy": {"mode": "per_dataset", "prefix": "test"},
            }
        )

        result = backend.get_all_chunks(
            knowledge_id="kb_1",
            max_chunks=100,
            metadata_condition={
                "operator": "and",
                "conditions": [{"key": "lang", "operator": "eq", "value": "zh"}],
            },
        )

        assert [chunk["doc_ref"] for chunk in result] == ["doc_1"]


class TestListDocuments:
    @patch("knowledge_engine.storage.elasticsearch_backend.Elasticsearch")
    def test_list_documents_returns_empty_page_when_index_missing(
        self, mock_client_class
    ):
        from knowledge_engine.storage.elasticsearch_backend import ElasticsearchBackend

        mock_client = MagicMock()
        mock_client_class.return_value = mock_client
        mock_client.indices.exists.return_value = False

        backend = ElasticsearchBackend(
            {
                "url": "http://localhost:9200",
                "indexStrategy": {"mode": "per_dataset", "prefix": "test"},
            }
        )

        result = backend.list_documents(knowledge_id="kb_1", page=2, page_size=10)

        assert result == {
            "documents": [],
            "total": 0,
            "page": 2,
            "page_size": 10,
            "knowledge_id": "kb_1",
        }
        mock_client.search.assert_not_called()


class TestDeleteDocument:
    @patch("knowledge_engine.storage.elasticsearch_backend.RawScoreElasticsearchStore")
    @patch("knowledge_engine.storage.elasticsearch_backend.Elasticsearch")
    def test_delete_document_removes_parent_nodes(
        self, mock_es_class, mock_store_class
    ):
        from knowledge_engine.storage.elasticsearch_backend import ElasticsearchBackend

        mock_store = MagicMock()
        mock_store.get_nodes.return_value = [MagicMock()]
        mock_store_class.return_value = mock_store

        mock_client = MagicMock()
        mock_client.indices.exists.return_value = True
        mock_client.delete_by_query.return_value = {"deleted": 1}
        mock_es_class.return_value = mock_client

        backend = ElasticsearchBackend(
            {
                "url": "http://localhost:9200",
                "indexStrategy": {"mode": "per_dataset", "prefix": "test"},
            }
        )

        result = backend.delete_document(knowledge_id="kb_1", doc_ref="doc_1")

        assert result["deleted_chunks"] == 1
        assert result["deleted_parent_nodes"] == 1
        assert result["index_name"] == "test_kb_kb_1"
        assert result["status"] == "deleted"
        mock_store.delete_nodes.assert_called_once()
        mock_client.delete_by_query.assert_called_once_with(
            index="test_kb_kb_1__parents",
            query={
                "bool": {
                    "filter": [
                        {"term": {"knowledge_id.keyword": "kb_1"}},
                        {"term": {"doc_ref.keyword": "doc_1"}},
                    ]
                }
            },
            refresh=True,
        )


class TestDeleteKnowledge:
    @patch("knowledge_engine.storage.elasticsearch_backend.Elasticsearch")
    def test_delete_knowledge_removes_all_chunks_for_one_knowledge_id(
        self, mock_es_class
    ):
        from knowledge_engine.storage.elasticsearch_backend import ElasticsearchBackend

        mock_client = MagicMock()
        mock_es_class.return_value = mock_client
        mock_client.indices.exists.side_effect = [True, True]
        mock_client.search.side_effect = [
            {"hits": {"total": {"value": 3, "relation": "eq"}, "hits": []}},
            {"hits": {"total": {"value": 2, "relation": "eq"}, "hits": []}},
        ]
        mock_client.delete_by_query.side_effect = [
            {"deleted": 3},
            {"deleted": 2},
        ]

        backend = ElasticsearchBackend(
            {
                "url": "http://localhost:9200",
                "indexStrategy": {"mode": "per_dataset", "prefix": "test"},
            }
        )

        result = backend.delete_knowledge(knowledge_id="kb_1")

        assert result == {
            "knowledge_id": "kb_1",
            "deleted_chunks": 3,
            "deleted_parent_nodes": 2,
            "status": "deleted",
        }
        assert mock_client.delete_by_query.call_count == 2
        mock_client.delete_by_query.assert_any_call(
            index="test_kb_kb_1",
            query={
                "bool": {
                    "filter": [{"term": {"metadata.knowledge_id.keyword": "kb_1"}}]
                }
            },
            refresh=True,
        )
        mock_client.delete_by_query.assert_any_call(
            index="test_kb_kb_1__parents",
            query={"bool": {"filter": [{"term": {"knowledge_id.keyword": "kb_1"}}]}},
            refresh=True,
        )


class TestSaveParentNodes:
    @patch("knowledge_engine.storage.elasticsearch_backend.Elasticsearch")
    def test_save_parent_nodes_replaces_existing_rows_for_same_document(
        self, mock_es_class
    ):
        from knowledge_engine.storage.elasticsearch_backend import ElasticsearchBackend

        mock_client = MagicMock()
        mock_es_class.return_value = mock_client
        mock_client.delete_by_query.return_value = {"deleted": 2}

        parent_node = MagicMock()
        parent_node.node_id = "parent-1"
        parent_node.text = "parent content"
        parent_node.metadata = {
            "doc_ref": "doc_123",
            "source_file": "test.md",
            "chunk_strategy": "hierarchical",
        }

        backend = ElasticsearchBackend(
            {
                "url": "http://localhost:9200",
                "indexStrategy": {"mode": "per_dataset", "prefix": "test"},
            }
        )

        result = backend.save_parent_nodes(
            knowledge_id="kb_1",
            parent_nodes=[parent_node],
        )

        assert result == {"stored_count": 1}
        mock_client.delete_by_query.assert_called_once_with(
            index="test_kb_kb_1__parents",
            query={
                "bool": {
                    "filter": [
                        {"term": {"knowledge_id.keyword": "kb_1"}},
                        {"term": {"doc_ref.keyword": "doc_123"}},
                    ]
                }
            },
            refresh=True,
        )


class TestDropKnowledgeIndex:
    def test_drop_knowledge_index_rejects_shared_index_strategy(self) -> None:
        from knowledge_engine.storage.elasticsearch_backend import ElasticsearchBackend

        backend = ElasticsearchBackend(
            {
                "url": "http://localhost:9200",
                "indexStrategy": {"mode": "per_user", "prefix": "test"},
            }
        )

        with pytest.raises(ValueError, match="Physical index drop is only allowed"):
            backend.drop_knowledge_index(knowledge_id="kb_1", user_id=7)

    @patch("knowledge_engine.storage.elasticsearch_backend.Elasticsearch")
    def test_drop_knowledge_index_drops_dedicated_kb_index_and_parent_store(
        self, mock_es_class
    ):
        from knowledge_engine.storage.elasticsearch_backend import ElasticsearchBackend

        mock_client = MagicMock()
        mock_es_class.return_value = mock_client
        mock_client.indices.exists.side_effect = [True, True]

        backend = ElasticsearchBackend(
            {
                "url": "http://localhost:9200",
                "indexStrategy": {"mode": "per_dataset", "prefix": "test"},
            }
        )

        result = backend.drop_knowledge_index(knowledge_id="kb_1")

        assert result == {
            "knowledge_id": "kb_1",
            "index_name": "test_kb_kb_1",
            "dropped_parent_index": True,
            "status": "dropped",
        }
        mock_client.indices.delete.assert_any_call(index="test_kb_kb_1")
        mock_client.indices.delete.assert_any_call(index="test_kb_kb_1__parents")
