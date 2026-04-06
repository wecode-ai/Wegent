# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from knowledge_engine.retrieval.filters import build_elasticsearch_filters


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
