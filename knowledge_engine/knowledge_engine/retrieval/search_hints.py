# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Helpers for consuming optional search hints in retrieval backends."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from shared.models import SearchHints


@dataclass(slots=True)
class ResolvedSearchQueries:
    """Resolved dense and sparse queries for one retrieval request."""

    dense_query: str
    sparse_query: str
    keywords: list[str]
    phrases: list[str]


def resolve_search_queries(
    query: str,
    retrieval_setting: dict[str, Any],
) -> ResolvedSearchQueries:
    """Resolve dense and sparse query strings from optional search hints."""

    search_hints = _coerce_search_hints(retrieval_setting.get("search_hints"))
    dense_query = _normalize_text(search_hints.semantic_query) if search_hints else ""
    if not dense_query:
        dense_query = query

    phrases = _normalize_terms(search_hints.phrases) if search_hints else []
    keywords = _normalize_terms(search_hints.keywords) if search_hints else []
    sparse_terms = phrases + [term for term in keywords if term not in phrases]
    sparse_query = " ".join(sparse_terms).strip() or query

    return ResolvedSearchQueries(
        dense_query=dense_query,
        sparse_query=sparse_query,
        keywords=keywords,
        phrases=phrases,
    )


def format_sparse_query_for_elasticsearch(
    resolved_queries: ResolvedSearchQueries,
) -> str:
    """Build a phrase-aware sparse query string for Elasticsearch."""

    parts = [f'"{phrase}"' for phrase in resolved_queries.phrases]
    parts.extend(
        term
        for term in resolved_queries.keywords
        if term not in resolved_queries.phrases
    )
    return " ".join(parts).strip() or resolved_queries.sparse_query


def _coerce_search_hints(value: Any) -> SearchHints | None:
    if value is None:
        return None
    if isinstance(value, SearchHints):
        return value
    if isinstance(value, dict):
        return SearchHints.model_validate(value)
    return None


def _normalize_terms(terms: list[str] | None) -> list[str]:
    if not terms:
        return []

    normalized_terms: list[str] = []
    seen: set[str] = set()
    for term in terms:
        normalized = _normalize_text(term)
        if not normalized or normalized in seen:
            continue
        normalized_terms.append(normalized)
        seen.add(normalized)
    return normalized_terms


def _normalize_text(value: str | None) -> str:
    return " ".join((value or "").split()).strip()
