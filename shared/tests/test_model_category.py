# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Model category parsing preserves Backend's current and legacy semantics."""

from enum import Enum

import pytest

from shared.utils.model_category import resolve_model_category


class Category(str, Enum):
    EMBEDDING = "embedding"


@pytest.mark.parametrize(
    ("spec", "expected"),
    [
        ({"modelType": "embedding"}, "embedding"),
        ({"modelConfig": {"modelType": "embedding"}}, "embedding"),
        ({"modelType": "llm", "modelConfig": {"modelType": "embedding"}}, "llm"),
        ({"modelType": None, "modelConfig": {"modelType": "embedding"}}, "embedding"),
        ({"modelType": "", "modelConfig": {"modelType": "embedding"}}, "llm"),
        ({"modelType": " EMBEDDING "}, "embedding"),
        ({"modelType": Category.EMBEDDING}, "embedding"),
        ({"modelType": " Unknown "}, "unknown"),
        ({"modelConfig": "invalid"}, "llm"),
        ({}, "llm"),
        (None, "llm"),
    ],
)
def test_resolve_model_category(spec, expected: str) -> None:
    assert resolve_model_category(spec) == expected
