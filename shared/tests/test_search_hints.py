# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import pytest
from pydantic import ValidationError

from shared.models import SearchHints, build_search_hint_plan


def test_search_hints_normalize_and_deduplicate_terms() -> None:
    hints = SearchHints.model_validate(
        {
            "semantic_query": "  compare   release checklist  ",
            "keywords": [" release ", "", "checklist", "release"],
            "phrases": ["release checklist", "  release checklist  "],
        }
    )

    assert hints.semantic_query == "compare release checklist"
    assert hints.keywords == ["release", "checklist"]
    assert hints.phrases == ["release checklist"]


def test_search_hints_reject_too_many_keywords() -> None:
    with pytest.raises(ValidationError):
        SearchHints.model_validate(
            {"keywords": [f"keyword-{index}" for index in range(21)]}
        )


def test_search_hints_reject_overlong_term() -> None:
    with pytest.raises(ValidationError):
        SearchHints.model_validate({"phrases": ["x" * 101]})


def test_build_search_hint_plan_uses_normalized_fallback() -> None:
    plan = build_search_hint_plan("  红包   520 发送   金额 规则  ")

    assert plan.normalized_query == "红包 520 发送 金额 规则"
    assert plan.dense_query == "红包 520 发送 金额 规则"
    assert plan.sparse_query == "红包 520 发送 金额 规则"
    assert plan.hint_source == "fallback"
