# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from knowledge_engine.retrieval.query_planning import build_search_hint_plan


def test_build_search_hint_plan_uses_normalized_fallback() -> None:
    plan = build_search_hint_plan("  红包   520 发送   金额 规则  ")

    assert plan.normalized_query == "红包 520 发送 金额 规则"
    assert plan.dense_query == "红包 520 发送 金额 规则"
    assert plan.sparse_query == "红包 520 发送 金额 规则"
    assert plan.hint_source == "fallback"


def test_build_search_hint_plan_uses_explicit_hints_for_dense_and_sparse_queries() -> (
    None
):
    plan = build_search_hint_plan(
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
