# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from knowledge_runtime.services.query_planner import QueryPlanner


def test_plan_keyword_bundle_is_no_op_and_normalized() -> None:
    plan = QueryPlanner().plan("  红包   520 发送   金额 规则  ")

    assert plan.normalized_query == "红包 520 发送 金额 规则"
    assert plan.dense_query == "红包 520 发送 金额 规则"
    assert plan.sparse_query == "红包 520 发送 金额 规则"
    assert plan.hint_source == "fallback"


def test_plan_uncertain_case_falls_back_to_keyword_bundle() -> None:
    plan = QueryPlanner().plan("红包不让抢 红包使用问题")

    assert plan.normalized_query == "红包不让抢 红包使用问题"
    assert plan.dense_query == "红包不让抢 红包使用问题"
    assert plan.sparse_query == "红包不让抢 红包使用问题"
    assert plan.hint_source == "fallback"


def test_plan_preserves_structured_spans() -> None:
    plan = QueryPlanner().plan("MCP 工具 添加 服务器 ghost spec mcpServers")

    assert "MCP" in plan.structured_spans
    assert "mcpServers" in plan.structured_spans
    assert plan.dense_query == "MCP 工具 添加 服务器 ghost spec mcpServers"


def test_plan_uses_explicit_hints_for_dense_and_sparse_queries() -> None:
    plan = QueryPlanner().plan(
        "抖音 小红书 夸克 搜索业务 重要指标 对比",
        {
            "semantic_query": "对比抖音、小红书和夸克的搜索业务重要指标",
            "keywords": ["抖音", "小红书", "夸克", "重要指标"],
            "phrases": ["搜索业务", "重要指标"],
        },
    )

    assert plan.hint_source == "explicit_hints"
    assert plan.dense_query == "对比抖音、小红书和夸克的搜索业务重要指标"
    assert plan.sparse_query == "搜索业务 重要指标 抖音 小红书 夸克"
    assert plan.phrases == ["搜索业务", "重要指标"]
    assert plan.keywords == ["抖音", "小红书", "夸克", "重要指标"]
