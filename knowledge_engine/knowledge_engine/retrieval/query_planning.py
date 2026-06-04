# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Shared retrieval planning helpers for dense and sparse query shaping."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from shared.models import (
    SearchHints,
    coerce_search_hints,
    normalize_search_text,
)

HintSource = Literal["explicit_hints", "fallback"]


@dataclass(slots=True)
class SearchHintPlan:
    """Normalized dense/sparse retrieval inputs resolved from query and hints."""

    normalized_query: str
    dense_query: str
    sparse_query: str
    keywords: list[str]
    phrases: list[str]
    hint_source: HintSource


def build_search_hint_plan(
    query: str,
    search_hints: SearchHints | dict[str, object] | None = None,
) -> SearchHintPlan:
    """Build normalized dense/sparse retrieval inputs from query and optional hints."""

    normalized_query = normalize_search_text(query)
    hints = coerce_search_hints(search_hints)
    semantic_query = hints.semantic_query if hints else ""
    phrases = list(hints.phrases or []) if hints else []
    keywords = list(hints.keywords or []) if hints else []
    sparse_terms = phrases + [term for term in keywords if term not in phrases]

    return SearchHintPlan(
        normalized_query=normalized_query,
        dense_query=semantic_query or normalized_query,
        sparse_query=" ".join(sparse_terms).strip() or normalized_query,
        keywords=keywords,
        phrases=phrases,
        hint_source=(
            "explicit_hints" if semantic_query or phrases or keywords else "fallback"
        ),
    )
