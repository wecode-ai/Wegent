# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Helpers for resolving dense and sparse retrieval queries."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from knowledge_engine.retrieval.query_planning import build_search_hint_plan
from shared.models import normalize_search_terms, normalize_search_text


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
    """Resolve dense and sparse query strings from plan fields or search hints."""

    planned_queries = _resolve_planned_queries(query, retrieval_setting)
    if planned_queries is not None:
        return planned_queries

    resolved = build_search_hint_plan(query, retrieval_setting.get("search_hints"))

    return ResolvedSearchQueries(
        dense_query=resolved.dense_query,
        sparse_query=resolved.sparse_query,
        keywords=resolved.keywords,
        phrases=resolved.phrases,
    )


def _resolve_planned_queries(
    query: str,
    retrieval_setting: dict[str, Any],
) -> ResolvedSearchQueries | None:
    dense_query = normalize_search_text(retrieval_setting.get("dense_query"))
    sparse_query = normalize_search_text(retrieval_setting.get("sparse_query"))
    keywords = normalize_search_terms(retrieval_setting.get("keywords"))
    phrases = normalize_search_terms(retrieval_setting.get("phrases"))

    if not dense_query and not sparse_query and not keywords and not phrases:
        return None

    fallback_query = normalize_search_text(query)
    dense_query = dense_query or fallback_query
    sparse_query = sparse_query or fallback_query or dense_query

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
