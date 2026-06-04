# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import json
from pathlib import Path

from knowledge_runtime.services.query_planner import QueryPlanner


def test_query_planner_regression_cases() -> None:
    fixture_path = Path(__file__).parent / "fixtures" / "query_planner_cases.json"
    cases = json.loads(fixture_path.read_text(encoding="utf-8"))
    planner = QueryPlanner()

    for case in cases:
        plan = planner.plan(case["query"])
        assert plan.hint_source == case["expected_hint_source"]
        assert plan.normalized_query == case["expected_normalized_query"]
        assert plan.dense_query == case["expected_dense_query"]
        assert plan.sparse_query == case["expected_sparse_query"]
