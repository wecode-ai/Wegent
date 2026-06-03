# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import pytest
from pydantic import ValidationError

from shared.models import SearchHints, normalize_search_terms, normalize_search_text


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


def test_normalize_helpers_are_stable() -> None:
    assert normalize_search_text("  红包   520 发送   金额 规则  ") == "红包 520 发送 金额 规则"
    assert normalize_search_terms([" release ", "", "checklist", "release"]) == [
        "release",
        "checklist",
    ]
