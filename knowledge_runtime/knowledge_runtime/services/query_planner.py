# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Query planner that resolves explicit dense and sparse retrieval inputs."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Literal

from shared.models import SearchHints, build_search_hint_plan

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
        resolved = build_search_hint_plan(query, search_hints)
        structured_spans = self._extract_structured_spans(resolved.normalized_query)

        return QueryPlan(
            original_query=query,
            normalized_query=resolved.normalized_query,
            dense_query=resolved.dense_query,
            sparse_query=resolved.sparse_query,
            keywords=resolved.keywords,
            phrases=resolved.phrases,
            hint_source=resolved.hint_source,
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
