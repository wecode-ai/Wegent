# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Query planner that resolves explicit dense and sparse retrieval inputs."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Literal

from shared.models import SearchHints

HintSource = Literal["explicit_hints", "fallback"]


@dataclass(slots=True)
class QueryPlan:
    """Resolved retrieval inputs for one query request."""

    original_query: str
    normalized_query: str
    dense_query: str
    sparse_query: str
    keywords: list[str] = field(default_factory=list)
    phrases: list[str] = field(default_factory=list)
    hint_source: HintSource = "fallback"
    structured_spans: list[str] = field(default_factory=list)


class QueryPlanner:
    """Build a retrieval plan from the raw query and optional search hints."""

    _SPACE_RE = re.compile(r"\s+")
    _STRUCTURED_TOKEN_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_./-]*")

    def plan(
        self,
        query: str,
        search_hints: SearchHints | dict[str, Any] | None = None,
    ) -> QueryPlan:
        normalized = self._normalize(query)
        structured_spans = self._extract_structured_spans(normalized)
        hints = self._coerce_search_hints(search_hints)
        semantic_query = self._normalize(getattr(hints, "semantic_query", None) or "")
        phrases = self._normalize_terms(getattr(hints, "phrases", None))
        keywords = self._normalize_terms(getattr(hints, "keywords", None))
        sparse_terms = phrases + [term for term in keywords if term not in phrases]
        dense_query = semantic_query or normalized
        sparse_query = " ".join(sparse_terms).strip() or normalized
        hint_source: HintSource = (
            "explicit_hints" if semantic_query or phrases or keywords else "fallback"
        )

        return QueryPlan(
            original_query=query,
            normalized_query=normalized,
            dense_query=dense_query,
            sparse_query=sparse_query,
            keywords=keywords,
            phrases=phrases,
            hint_source=hint_source,
            structured_spans=structured_spans,
        )

    def _normalize(self, query: str | None) -> str:
        return self._SPACE_RE.sub(" ", query or "").strip()

    def _extract_structured_spans(self, query: str) -> list[str]:
        spans: list[str] = []
        for token in self._STRUCTURED_TOKEN_RE.findall(query):
            if "_" in token or any(ch.isupper() for ch in token):
                spans.append(token)
        return spans

    def _normalize_terms(self, terms: list[str] | None) -> list[str]:
        if not terms:
            return []

        normalized_terms: list[str] = []
        seen: set[str] = set()
        for term in terms:
            normalized = self._normalize(term)
            if not normalized or normalized in seen:
                continue
            normalized_terms.append(normalized)
            seen.add(normalized)
        return normalized_terms

    def _coerce_search_hints(
        self,
        search_hints: SearchHints | dict[str, Any] | None,
    ) -> SearchHints | None:
        if search_hints is None:
            return None
        if isinstance(search_hints, SearchHints):
            return search_hints
        if isinstance(search_hints, dict):
            return SearchHints.model_validate(search_hints)
        return None
