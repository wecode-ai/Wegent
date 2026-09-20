# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from typing import Any

import pytest
from llama_index.core.vector_stores import (
    FilterCondition,
    FilterOperator,
    MetadataFilters,
)

from knowledge_engine.retrieval.filters import (
    build_elasticsearch_filters,
    filter_chunk_records,
    iter_valid_conditions,
    normalize_metadata_operator,
    parse_metadata_filters,
    validate_metadata_condition,
)

# The shared vocabulary Milvus cannot compile, with what each other backend
# still produces for it. Both tables are keyed by the operator, so a backend
# whose expectation goes missing fails here instead of dropping out silently.
OPERATORS_MILVUS_CANNOT_COMPILE = (
    "ne",
    "nin",
    "gt",
    "gte",
    "lt",
    "lte",
    "contains",
    "text_match",
)
ELASTICSEARCH_CLAUSES = {
    "ne": {"bool": {"must_not": {"term": {"metadata.lang.keyword": "zh"}}}},
    "nin": {"bool": {"must_not": {"terms": {"metadata.lang.keyword": "zh"}}}},
    "gt": {"range": {"metadata.lang": {"gt": "zh"}}},
    "gte": {"range": {"metadata.lang": {"gte": "zh"}}},
    "lt": {"range": {"metadata.lang": {"lt": "zh"}}},
    "lte": {"range": {"metadata.lang": {"lte": "zh"}}},
    "contains": {"wildcard": {"metadata.lang.keyword": "*zh*"}},
    "text_match": {"match": {"metadata.lang": "zh"}},
}
QDRANT_FILTER_OPERATORS = {
    "ne": FilterOperator.NE,
    "nin": FilterOperator.NIN,
    "gt": FilterOperator.GT,
    "gte": FilterOperator.GTE,
    "lt": FilterOperator.LT,
    "lte": FilterOperator.LTE,
    "contains": FilterOperator.CONTAINS,
    "text_match": FilterOperator.TEXT_MATCH,
}


@pytest.mark.parametrize(
    ("raw_operator", "expected"),
    [
        (None, "eq"),
        ("EQ", "eq"),
        ("==", "eq"),
        ("!=", "ne"),
        (" text_match ", "text_match"),
    ],
)
def test_normalize_metadata_operator_is_shared_by_every_backend(
    raw_operator, expected
) -> None:
    assert normalize_metadata_operator(raw_operator) == expected


def test_iter_valid_conditions_skips_conditions_without_a_constraint() -> None:
    """A missing key or a null value carries no constraint on any backend."""
    conditions = iter_valid_conditions(
        {
            "operator": "and",
            "conditions": [
                {"key": "category", "operator": "eq", "value": "tech"},
                {"key": "category", "operator": "eq", "value": None},
                {"operator": "eq", "value": "orphan"},
            ],
        }
    )

    assert conditions == [{"key": "category", "operator": "eq", "value": "tech"}]


@pytest.mark.parametrize(
    "metadata_condition",
    [
        # A condition this contract cannot honour must not read as no condition.
        {"doc_ref": "x"},
        {"category": "tech"},
        # A stated field must never be dropped, with or without conditions.
        {"conditions": [], "doc_ref": "x"},
        {"operator": "and", "conditions": [{"key": "a"}], "category": "tech"},
        # A missing conditions list is "no constraint" only for a plain and.
        {"operator": "or"},
        {"operator": "OR"},
        {"operator": "xor"},
        # Naming a combination this contract does not compile states the same
        # thing with or without the conditions it would combine.
        {"operator": "not", "conditions": [{"key": "a", "operator": "eq"}]},
        {"operator": "xor", "conditions": [{"key": "a", "operator": "eq"}]},
        # Only an absent value and an empty mapping express no constraint.
        [],
        "",
        # The conditions themselves are one list of objects.
        {"conditions": None},
        {"operator": "and", "conditions": "category"},
        {"operator": "and", "conditions": {"key": "category"}},
        {"operator": "and", "conditions": ({"key": "category"},)},
        {"operator": "and", "conditions": [None]},
        {"operator": "and", "conditions": [["key", "category"]]},
        {"operator": "and", "conditions": [{"key": "a"}, "category"]},
        # Anything that is not a condition object at all.
        ["category"],
        "category",
        ({"key": "category"},),
    ],
)
def test_validate_metadata_condition_rejects_a_malformed_shape(
    metadata_condition: Any,
) -> None:
    """Every entry point rejects a shape it cannot honour, before filtering."""
    with pytest.raises(ValueError):
        validate_metadata_condition(metadata_condition)


def test_validate_metadata_condition_accepts_an_absent_condition() -> None:
    """An absent value, an empty mapping and a lone operator constrain nothing."""
    validate_metadata_condition(None)
    validate_metadata_condition({})
    validate_metadata_condition({"operator": "and"})


@pytest.mark.parametrize("operator", OPERATORS_MILVUS_CANNOT_COMPILE)
def test_validate_metadata_condition_keeps_the_operators_milvus_cannot_compile(
    operator: str,
) -> None:
    """``eq``/``in`` is Milvus's limit, so the shared contract stays wider."""
    validate_metadata_condition(
        {
            "operator": "or",
            "conditions": [{"key": "lang", "operator": operator, "value": "zh"}],
        }
    )


def test_build_elasticsearch_filters_normalizes_mixed_case_operators() -> None:
    filters = build_elasticsearch_filters(
        "kb_1",
        {
            "operator": "and",
            "conditions": [
                {"key": "priority", "operator": "GTE", "value": 3},
                {"key": "tag", "operator": "CONTAINS", "value": "release"},
            ],
        },
    )

    assert filters == [
        {"term": {"metadata.knowledge_id.keyword": "kb_1"}},
        {"range": {"metadata.priority": {"gte": 3}}},
        {"wildcard": {"metadata.tag.keyword": "*release*"}},
    ]


def test_build_elasticsearch_filters_defaults_none_operator_to_eq() -> None:
    filters = build_elasticsearch_filters(
        "kb_1",
        {
            "operator": "and",
            "conditions": [
                {"key": "priority", "operator": None, "value": 3},
            ],
        },
    )

    assert filters == [
        {"term": {"metadata.knowledge_id.keyword": "kb_1"}},
        {"term": {"metadata.priority.keyword": 3}},
    ]


def test_build_elasticsearch_filters_defaults_unknown_operator_to_eq() -> None:
    filters = build_elasticsearch_filters(
        "kb_1",
        {
            "operator": "and",
            "conditions": [
                {"key": "lang", "operator": "unknown", "value": "zh"},
            ],
        },
    )

    assert filters == [
        {"term": {"metadata.knowledge_id.keyword": "kb_1"}},
        {"term": {"metadata.lang.keyword": "zh"}},
    ]


def test_build_elasticsearch_filters_normalizes_operator_aliases() -> None:
    filters = build_elasticsearch_filters(
        "kb_1",
        {
            "operator": "and",
            "conditions": [
                {"key": "lang", "operator": "==", "value": "zh"},
                {"key": "status", "operator": "!=", "value": "archived"},
            ],
        },
    )

    assert filters == [
        {"term": {"metadata.knowledge_id.keyword": "kb_1"}},
        {"term": {"metadata.lang.keyword": "zh"}},
        {"bool": {"must_not": {"term": {"metadata.status.keyword": "archived"}}}},
    ]


@pytest.mark.parametrize("operator", OPERATORS_MILVUS_CANNOT_COMPILE)
def test_build_elasticsearch_filters_keeps_the_operators_milvus_cannot_compile(
    operator: str,
) -> None:
    """Elasticsearch keeps compiling every operator it served before."""
    filters = build_elasticsearch_filters(
        "kb_1",
        {
            "operator": "and",
            "conditions": [{"key": "lang", "operator": operator, "value": "zh"}],
        },
    )

    assert filters == [
        {"term": {"metadata.knowledge_id.keyword": "kb_1"}},
        ELASTICSEARCH_CLAUSES[operator],
    ]


@pytest.mark.parametrize("operator", OPERATORS_MILVUS_CANNOT_COMPILE)
def test_parse_metadata_filters_keeps_the_operators_milvus_cannot_compile(
    operator: str,
) -> None:
    """Qdrant keeps the operator vocabulary it served before."""
    filters = parse_metadata_filters(
        "kb_1",
        {
            "operator": "and",
            "conditions": [{"key": "lang", "operator": operator, "value": "zh"}],
        },
    )

    user_filters = filters.filters[1]
    assert isinstance(user_filters, MetadataFilters)
    assert user_filters.filters[0].operator == QDRANT_FILTER_OPERATORS[operator]


def test_parse_metadata_filters_normalizes_operator_aliases() -> None:
    filters = parse_metadata_filters(
        "kb_1",
        {
            "operator": "and",
            "conditions": [
                {"key": "lang", "operator": "==", "value": "zh"},
                {"key": "status", "operator": "!=", "value": "archived"},
            ],
        },
    )

    assert filters.condition == FilterCondition.AND
    assert filters.filters[0].key == "knowledge_id"
    assert isinstance(filters.filters[1], MetadataFilters)
    assert filters.filters[1].condition == FilterCondition.AND
    assert filters.filters[1].filters[0].operator == FilterOperator.EQ
    assert filters.filters[1].filters[1].operator == FilterOperator.NE


def test_parse_metadata_filters_keeps_knowledge_id_outside_user_or() -> None:
    filters = parse_metadata_filters(
        "kb_1",
        {
            "operator": "or",
            "conditions": [
                {"key": "lang", "operator": "==", "value": "zh"},
                {"key": "source", "operator": "==", "value": "manual"},
            ],
        },
    )

    assert filters.condition == FilterCondition.AND
    assert filters.filters[0].key == "knowledge_id"
    assert filters.filters[0].value == "kb_1"
    assert isinstance(filters.filters[1], MetadataFilters)
    assert filters.filters[1].condition == FilterCondition.OR
    assert [condition.key for condition in filters.filters[1].filters] == [
        "lang",
        "source",
    ]


def test_build_elasticsearch_filters_keeps_knowledge_id_outside_user_or() -> None:
    filters = build_elasticsearch_filters(
        "kb_1",
        {
            "operator": "or",
            "conditions": [
                {"key": "lang", "operator": "==", "value": "zh"},
                {"key": "source", "operator": "==", "value": "manual"},
            ],
        },
    )

    assert filters == [
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


def test_parse_metadata_filters_rejects_nested_conditions() -> None:
    with pytest.raises(ValueError, match="Nested metadata conditions"):
        parse_metadata_filters(
            "kb_1",
            {
                "operator": "and",
                "conditions": [
                    {
                        "operator": "or",
                        "conditions": [
                            {"key": "lang", "operator": "==", "value": "zh"}
                        ],
                    }
                ],
            },
        )


def test_build_elasticsearch_filters_rejects_not_operator() -> None:
    with pytest.raises(ValueError, match="operator 'not' is not supported"):
        build_elasticsearch_filters(
            "kb_1",
            {
                "operator": "not",
                "conditions": [
                    {"key": "status", "operator": "==", "value": "archived"}
                ],
            },
        )


@pytest.mark.parametrize("operator", ["eq", "in", "contains"])
def test_parse_metadata_filters_rejects_document_scope_metadata(
    operator: str,
) -> None:
    with pytest.raises(ValueError, match=r"RetrievalScope\.document_ids"):
        parse_metadata_filters(
            "kb_1",
            {
                "operator": "and",
                "conditions": [{"key": "doc_ref", "operator": operator, "value": "10"}],
            },
        )


def test_filter_chunk_records_still_allows_doc_ref_for_chunk_listing() -> None:
    chunks = [
        {"content": "a", "metadata": {"doc_ref": "10"}},
        {"content": "b", "metadata": {"doc_ref": "20"}},
    ]

    filtered = filter_chunk_records(
        chunks,
        {
            "operator": "and",
            "conditions": [
                {"key": "doc_ref", "operator": "eq", "value": "10"},
            ],
        },
    )

    assert filtered == [{"content": "a", "metadata": {"doc_ref": "10"}}]


def test_filter_chunk_records_ignores_invalid_conditions_in_or_tree() -> None:
    chunks = [
        {"content": "a", "metadata": {"lang": "zh"}},
        {"content": "b", "metadata": {"lang": "en"}},
    ]

    filtered = filter_chunk_records(
        chunks,
        {
            "operator": "or",
            "conditions": [
                {"operator": "eq", "value": "ignored"},
                {"key": "lang", "operator": "eq", "value": "zh"},
                {"key": "status", "operator": "eq", "value": None},
            ],
        },
    )

    assert filtered == [{"content": "a", "metadata": {"lang": "zh"}}]


def test_filter_chunk_records_treats_an_empty_condition_as_no_constraint() -> None:
    """An empty mapping states nothing, so it filters nothing."""
    chunks = [{"content": "a", "metadata": {"lang": "zh"}}]

    assert filter_chunk_records(chunks, {}) == chunks


@pytest.mark.parametrize("metadata_condition", [[], "", 0])
def test_filter_chunk_records_rejects_a_condition_that_is_not_an_object(
    metadata_condition: Any,
) -> None:
    """A value that states no filtering must not be served as one that does."""
    chunks = [{"content": "a", "metadata": {"lang": "zh"}}]

    with pytest.raises(ValueError):
        filter_chunk_records(chunks, metadata_condition)
