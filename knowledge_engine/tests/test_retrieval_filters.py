# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest
from llama_index.core.vector_stores import (
    FilterCondition,
    FilterOperator,
    MetadataFilters,
)

from knowledge_engine.retrieval.filters import (
    build_elasticsearch_filters,
    filter_chunk_records,
    parse_metadata_filters,
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
