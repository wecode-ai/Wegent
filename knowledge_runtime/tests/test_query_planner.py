# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from knowledge_runtime.services.query_planner import QueryPlanner


def test_plan_keyword_bundle_is_no_op_and_normalized() -> None:
    plan = QueryPlanner().plan("  红包   520 发送   金额 规则  ")

    assert plan.query_type == "keyword_bundle"
    assert plan.normalized_query == "红包 520 发送 金额 规则"
    assert plan.backend_query == "红包 520 发送 金额 规则"
    assert plan.sparse_query is None


def test_plan_uncertain_case_falls_back_to_keyword_bundle() -> None:
    plan = QueryPlanner().plan("红包不让抢 红包使用问题")

    assert plan.query_type == "keyword_bundle"
    assert plan.backend_query == "红包不让抢 红包使用问题"


def test_plan_preserves_structured_spans() -> None:
    plan = QueryPlanner().plan("MCP 工具 添加 服务器 ghost spec mcpServers")

    assert "MCP" in plan.structured_spans
    assert "mcpServers" in plan.structured_spans
    assert plan.backend_query == "MCP 工具 添加 服务器 ghost spec mcpServers"
