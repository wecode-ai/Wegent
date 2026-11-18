# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""A second caller consumes the public operations without product services."""

from typing import Any, Mapping
from unittest.mock import AsyncMock, MagicMock

import pytest

from shared.knowledge_contracts import RuntimeRetrievalConfig


class _CandidateQueryAdapter:
    """Return only the candidate window a storage query was asked to retrieve."""

    def __init__(self, records: list[dict[str, Any]]) -> None:
        self.records = records
        self.executed_config: RuntimeRetrievalConfig | Mapping[str, Any] | None = None

    async def execute(self, **kwargs: Any) -> dict[str, Any]:
        self.executed_config = kwargs["retrieval_config"]
        config = self.executed_config
        top_k = (
            config.top_k
            if isinstance(config, RuntimeRetrievalConfig)
            else config.get("top_k", 20)
        )
        return {"records": self.records[:top_k]}


@pytest.mark.asyncio
async def test_empty_authorized_scope_never_queries_storage():
    from shared.knowledge_module import QueryTarget, query_documents

    engine = AsyncMock()
    result = await query_documents(
        [QueryTarget(engine, "space", {}, document_ids=[])],
        query="secret",
    )
    assert result == {"records": [], "total": 0, "total_estimated_tokens": 0}
    engine.execute.assert_not_called()


@pytest.mark.asyncio
async def test_scoped_query_keeps_reference_and_scope():
    from shared.knowledge_module import QueryTarget, query_documents

    engine = AsyncMock()
    engine.execute.return_value = {
        "records": [{"content": "hit", "metadata": {"doc_ref": "doc_7"}}]
    }
    result = await query_documents(
        [QueryTarget(engine, "space", {}, document_ids=[7])],
        query="needle",
    )
    assert result["records"][0]["document_id"] == 7
    assert engine.execute.call_args.kwargs["scope"].document_ids == [7]


@pytest.mark.asyncio
async def test_management_lists_then_clears_and_drops_one_space():
    from shared.knowledge_module import manage_index

    store = MagicMock()
    store.get_all_chunks.return_value = [{"content": "body", "doc_ref": "7"}]
    store.extract_chunk_text.side_effect = lambda value: value
    store.delete_knowledge.return_value = {"deleted_chunks": 1}
    store.drop_knowledge_index.return_value = {"status": "dropped"}
    listed = await manage_index(
        store, operation="list_chunks", knowledge_id="space", user_id=42
    )
    assert listed == {
        "chunks": [
            {
                "content": "body",
                "title": "",
                "chunk_id": None,
                "doc_ref": "7",
                "metadata": None,
            }
        ],
        "total": 1,
    }
    assert await manage_index(
        store, operation="purge", knowledge_id="space", user_id=42
    ) == {"deleted_chunks": 1}
    assert await manage_index(
        store, operation="drop", knowledge_id="space", user_id=42
    ) == {"status": "dropped"}
    store.delete_knowledge.assert_called_once_with(knowledge_id="space", user_id=42)


@pytest.mark.asyncio
async def test_multi_space_query_ranks_globally_and_preserves_total():
    from shared.knowledge_module import QueryTarget, query_documents

    first, second = AsyncMock(), AsyncMock()
    first.execute.return_value = {"records": [{"content": "low", "score": 0.2}]}
    second.execute.return_value = {"records": [{"content": "high-hit", "score": 0.9}]}
    result = await query_documents(
        [QueryTarget(first, "one", {}), QueryTarget(second, "two", {})],
        query="needle",
        max_results=1,
    )
    assert result["records"] == [
        {
            "content": "high-hit",
            "score": 0.9,
            "knowledge_id": "two",
            "document_id": None,
        }
    ]
    assert result["total"] == 2
    assert result["total_estimated_tokens"] == 2


@pytest.mark.asyncio
@pytest.mark.parametrize("deduplicate", [False, True])
async def test_document_diversity_finds_other_documents_before_result_limit(
    deduplicate: bool,
) -> None:
    from shared.knowledge_module import QueryTarget, query_documents

    adapter = _CandidateQueryAdapter(
        [
            {"content": "repeat", "score": 0.98, "metadata": {"doc_ref": "doc_7"}},
            {"content": "best", "score": 0.99, "metadata": {"doc_ref": "7"}},
            {"content": "other-doc", "score": 0.8, "metadata": {"doc_ref": "doc_8"}},
        ]
    )
    config = {"top_k": 2, "score_threshold": 0.1}
    options = {"deduplicate_by_document": True} if deduplicate else {}

    result = await query_documents(
        [QueryTarget(adapter, "one", config)],
        query="needle",
        max_results=2,
        **options,
    )

    expected = ["best", "other-doc"] if deduplicate else ["best", "repeat"]
    assert [record["content"] for record in result["records"]] == expected
    assert result["total"] == (3 if deduplicate else 2)
    assert result["total_estimated_tokens"] == sum(len(text) // 4 for text in expected)
    assert config == {"top_k": 2, "score_threshold": 0.1}
    assert adapter.executed_config == {
        "top_k": 8 if deduplicate else 2,
        "score_threshold": 0.1,
    }


@pytest.mark.asyncio
async def test_document_diversity_scopes_normalized_ids_and_keeps_unknowns() -> None:
    from shared.knowledge_module import QueryTarget, query_documents

    one = _CandidateQueryAdapter(
        [
            {"content": "lower", "score": 0.6, "metadata": {"doc_ref": "doc_7"}},
            {"content": "best", "score": 0.8, "metadata": {"doc_ref": "0007"}},
            {"content": "missing", "score": 0.7},
            {"content": "invalid-one", "score": 0.5, "metadata": {"doc_ref": "bad"}},
            {"content": "invalid-two", "score": 0.4, "metadata": {"doc_ref": "bad"}},
            {"content": "empty", "score": 0.3, "metadata": {"doc_ref": ""}},
        ]
    )
    two = _CandidateQueryAdapter(
        [{"content": "other-kb", "score": 0.9, "metadata": {"doc_ref": "doc_7"}}]
    )

    result = await query_documents(
        [QueryTarget(one, "one", {}), QueryTarget(two, "two", {})],
        query="needle",
        deduplicate_by_document=True,
    )

    assert [record["content"] for record in result["records"]] == [
        "other-kb",
        "best",
        "missing",
        "invalid-one",
        "invalid-two",
        "empty",
    ]
    assert [
        (record["knowledge_id"], record["document_id"]) for record in result["records"]
    ] == [("two", 7), ("one", 7)] + [("one", None)] * 4
    assert result["total"] == 7
    assert one.executed_config == two.executed_config == {}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "reference_fields",
    [
        {"document_id": 7},
        {"document_id": "doc_007"},
        {"metadata": {"document_id": 7}},
        {"metadata": {"document_id": "007"}},
        {"doc_ref": "doc_7"},
        {"doc_ref": 7},
        {"metadata": {"doc_ref": 7}},
        {"document_id": True, "metadata": {"document_id": 7}},
        {"document_id": 0, "doc_ref": "doc_7"},
        {"document_id": 7, "metadata": {"doc_ref": "doc_8"}},
        {"document_id": "bad", "metadata": {"document_id": "doc_7"}},
    ],
)
async def test_document_diversity_normalizes_direct_and_metadata_ids(
    reference_fields: dict[str, Any],
) -> None:
    from shared.knowledge_module import QueryTarget, query_documents

    adapter = _CandidateQueryAdapter(
        [
            {"content": "best", "score": 0.99, **reference_fields},
            {"content": "repeat", "score": 0.98, "metadata": {"doc_ref": "doc_7"}},
            {"content": "other", "score": 0.9, "metadata": {"doc_ref": "doc_8"}},
        ]
    )

    result = await query_documents(
        [QueryTarget(adapter, "one", {"top_k": 2})],
        query="needle",
        max_results=2,
        deduplicate_by_document=True,
    )

    assert [record["document_id"] for record in result["records"]] == [7, 8]
    assert [record["content"] for record in result["records"]] == ["best", "other"]
    assert result["total"] == 3


@pytest.mark.asyncio
async def test_document_diversity_keeps_invalid_ids_as_independent_records() -> None:
    from shared.knowledge_module import QueryTarget, query_documents

    invalid_ids = [
        True,
        False,
        7.0,
        0,
        -7,
        "0",
        "doc_0",
        "doc_-7",
        " 7 ",
        "bad",
        None,
        "²",
    ]
    candidates = [
        {
            "content": f"unknown-{i}",
            "score": 0.9,
            "document_id": value,
            "doc_ref": value,
            "metadata": {"document_id": value, "doc_ref": value},
        }
        for i, value in enumerate(invalid_ids)
    ]

    result = await query_documents(
        [QueryTarget(_CandidateQueryAdapter(candidates), "one", {})],
        query="needle",
        deduplicate_by_document=True,
    )

    assert result["total"] == len(invalid_ids)
    assert [record["document_id"] for record in result["records"]] == [None] * len(
        invalid_ids
    )
    assert [record["content"] for record in result["records"]] == [
        candidate["content"] for candidate in candidates
    ]


@pytest.mark.asyncio
async def test_default_query_preserves_legacy_document_id_normalization() -> None:
    from shared.knowledge_module import QueryTarget, query_documents

    candidates = [
        {"content": "direct", "document_id": 7},
        {"content": "metadata", "metadata": {"document_id": 7}},
        {"content": "legacy", "metadata": {"doc_ref": "doc_7"}},
    ]
    adapter = _CandidateQueryAdapter(candidates)

    result = await query_documents(
        [QueryTarget(adapter, "one", {})], query="needle", max_results=3
    )

    assert [record["document_id"] for record in result["records"]] == [None, None, 7]
    assert result["total"] == 3
    assert adapter.executed_config == {}


@pytest.mark.asyncio
@pytest.mark.parametrize("as_model", [False, True])
@pytest.mark.parametrize(
    "current_top_k, max_results, expected_top_k",
    [(2, 3, 12), (None, 2, 20), (None, 6, 24), (50, 100, 200), (250, 100, 250)],
)
async def test_document_diversity_candidate_window_is_bounded_without_reduction(
    as_model: bool,
    current_top_k: int | None,
    max_results: int,
    expected_top_k: int,
) -> None:
    from shared.knowledge_module import QueryTarget, query_documents

    values = {"score_threshold": 0.1, "retrieval_mode": "keyword"}
    if current_top_k is not None:
        values["top_k"] = current_top_k
    config = RuntimeRetrievalConfig(**values) if as_model else values
    original = config.model_dump() if as_model else dict(config)
    adapter = _CandidateQueryAdapter(
        [
            {"content": str(i), "score": 0.9, "metadata": {"doc_ref": f"doc_{i}"}}
            for i in range(1, expected_top_k + 2)
        ]
    )

    result = await query_documents(
        [QueryTarget(adapter, "one", config)],
        query="needle",
        max_results=max_results,
        deduplicate_by_document=True,
    )

    assert result["total"] == expected_top_k
    assert len(result["records"]) == min(max_results, expected_top_k)
    executed = adapter.executed_config
    executed = executed.model_dump() if as_model else dict(executed)
    assert executed == {**original, "top_k": expected_top_k}
    assert (config.model_dump() if as_model else config) == original


@pytest.mark.asyncio
@pytest.mark.parametrize("value", ["false", 1, None])
async def test_query_documents_rejects_non_boolean_document_diversity(value) -> None:
    from shared.knowledge_module import query_documents

    with pytest.raises(TypeError, match="deduplicate_by_document must be a boolean"):
        await query_documents([], query="needle", deduplicate_by_document=value)


@pytest.mark.asyncio
async def test_mixed_targets_keep_independent_scopes_and_plans() -> None:
    from shared.knowledge_module import QueryTarget, query_documents

    whole, scoped, empty = AsyncMock(), AsyncMock(), AsyncMock()
    whole.execute.return_value = {"records": []}
    scoped.execute.return_value = {"records": []}
    qa_plan = {"dense_query": "question", "hint_source": "qa_pair_profile"}
    await query_documents(
        [
            QueryTarget(whole, "whole", {}),
            QueryTarget(scoped, "scoped", {}, document_ids=[7], query_plan=qa_plan),
            QueryTarget(empty, "empty", {}, document_ids=[]),
        ],
        query="question",
    )

    whole.execute.assert_awaited_once()
    assert whole.execute.await_args.kwargs["scope"] is None
    assert whole.execute.await_args.kwargs["query_plan"] is None
    scoped.execute.assert_awaited_once()
    assert scoped.execute.await_args.kwargs["scope"].document_ids == [7]
    assert scoped.execute.await_args.kwargs["query_plan"] == qa_plan
    empty.execute.assert_not_called()


@pytest.mark.asyncio
async def test_management_passes_document_scope_to_storage() -> None:
    from shared.knowledge_contracts import RetrievalScope
    from shared.knowledge_module import manage_index

    store = MagicMock()
    store.get_all_chunks.return_value = []
    scope = RetrievalScope(document_ids=[12])
    result = await manage_index(
        store, operation="list_chunks", knowledge_id="1", scope=scope
    )
    assert result == {"chunks": [], "total": 0}
    assert store.get_all_chunks.call_args.kwargs["scope"] == scope
