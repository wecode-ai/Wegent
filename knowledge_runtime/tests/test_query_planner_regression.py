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
        assert plan.query_type == case["expected_type"]
        assert plan.backend_query == case["expected_backend_query"]
