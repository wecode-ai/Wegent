# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from llama_index.core.vector_stores import FilterOperator

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
        {"range": {"metadata.priority.keyword": {"gte": 3}}},
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

    assert filters.filters[1].operator == FilterOperator.EQ
    assert filters.filters[2].operator == FilterOperator.NE


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
