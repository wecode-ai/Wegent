# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Typed search hints and shared normalization helpers."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field, field_validator

MAX_SEARCH_QUERY_LENGTH = 2000
MAX_SEARCH_HINT_TERM_LENGTH = 100
MAX_SEARCH_HINT_KEYWORDS = 20
MAX_SEARCH_HINT_PHRASES = 10

def normalize_search_text(value: str | None) -> str:
    """Normalize free-form query text into a single-space representation."""

    return " ".join((value or "").split()).strip()


def normalize_search_terms(terms: list[str] | None) -> list[str]:
    """Normalize, deduplicate, and drop empty search terms while preserving order."""

    if not terms:
        return []

    normalized_terms: list[str] = []
    seen: set[str] = set()
    for term in terms:
        normalized = normalize_search_text(term)
        if not normalized or normalized in seen:
            continue
        normalized_terms.append(normalized)
        seen.add(normalized)
    return normalized_terms


class SearchHints(BaseModel):
    """Optional retrieval hints produced by an upstream planner or LLM."""

    model_config = ConfigDict(extra="forbid")

    semantic_query: str | None = Field(
        default=None,
        max_length=MAX_SEARCH_QUERY_LENGTH,
    )
    keywords: list[str] | None = Field(
        default=None,
        max_length=MAX_SEARCH_HINT_KEYWORDS,
    )
    phrases: list[str] | None = Field(
        default=None,
        max_length=MAX_SEARCH_HINT_PHRASES,
    )

    @field_validator("semantic_query")
    @classmethod
    def normalize_semantic_query(cls, value: str | None) -> str | None:
        normalized = normalize_search_text(value)
        return normalized or None

    @field_validator("keywords", "phrases")
    @classmethod
    def normalize_hint_terms(cls, value: list[str] | None) -> list[str] | None:
        normalized = normalize_search_terms(value)
        if not normalized:
            return None
        for term in normalized:
            if len(term) > MAX_SEARCH_HINT_TERM_LENGTH:
                raise ValueError(
                    f"search hint terms must be at most {MAX_SEARCH_HINT_TERM_LENGTH} characters"
                )
        return normalized
def coerce_search_hints(
    search_hints: SearchHints | dict[str, object] | None,
) -> SearchHints | None:
    """Coerce dict payloads into typed SearchHints instances."""

    if search_hints is None:
        return None
    if isinstance(search_hints, SearchHints):
        return search_hints
    if isinstance(search_hints, dict):
        return SearchHints.model_validate(search_hints)
    return None
