# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Shared retrieval planning helpers for dense and sparse query shaping."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal

from shared.models import (
    SearchHints,
    coerce_search_hints,
    normalize_search_terms,
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


def build_qa_search_hint_plan(query: str) -> SearchHintPlan:
    """Build deterministic dense/sparse hints for Q&A retrieval."""

    normalized_query = normalize_search_text(query)
    phrases = _extract_qa_phrases(normalized_query)
    keywords = _extract_qa_keywords(normalized_query, phrases)
    sparse_terms = phrases + [term for term in keywords if term not in phrases]

    return SearchHintPlan(
        normalized_query=normalized_query,
        dense_query=normalized_query,
        sparse_query=" ".join(sparse_terms).strip() or normalized_query,
        keywords=keywords,
        phrases=phrases,
        hint_source="explicit_hints" if sparse_terms else "fallback",
    )


def _extract_qa_phrases(query: str) -> list[str]:
    quoted_phrases = re.findall(r"[\"“”'‘’]([^\"“”'‘’]{2,40})[\"“”'‘’]", query)
    cjk_named_phrases = re.findall(
        r"[\u4e00-\u9fffA-Za-z0-9]{2,24}(?:模式|平台|矩阵|机制|策略|指标|疫苗|创新药|大健康)",
        query,
    )
    return normalize_search_terms([*quoted_phrases, *cjk_named_phrases])[:10]


def _extract_qa_keywords(query: str, phrases: list[str]) -> list[str]:
    tokens = re.findall(
        r"[A-Za-z][A-Za-z0-9_.+-]{1,30}|\d+(?:\.\d+)?%?|[\u4e00-\u9fff]{2,12}",
        query,
    )
    phrase_terms: list[str] = []
    for phrase in phrases:
        phrase_terms.extend(
            re.findall(r"[A-Za-z0-9_.+-]+|[\u4e00-\u9fff]{2,12}", phrase)
        )
    return normalize_search_terms([*tokens, *phrase_terms])[:20]
