# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Conservative query planner for phase-1 keyword retrieval planning."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Literal

QueryType = Literal[
    "keyword_bundle",
    "short_phrase_sentence",
    "enumeration_or_topic",
    "structured_span",
    "natural_sentence",
]


@dataclass(slots=True)
class QueryPlan:
    """Normalized query planning result for one retrieval request."""

    original_query: str
    normalized_query: str
    backend_query: str
    query_type: QueryType
    sparse_query: str | None = None
    phrase_spans: list[str] = field(default_factory=list)
    structured_spans: list[str] = field(default_factory=list)


class QueryPlanner:
    """Build a conservative single-query plan for phase-1 retrieval."""

    _SPACE_RE = re.compile(r"\s+")
    _STRUCTURED_TOKEN_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_./-]*")
    _SENTENCE_HINT_RE = re.compile(r"[？?]|如何|怎么|为什么|是什么")

    def plan(self, query: str) -> QueryPlan:
        normalized = self._normalize(query)
        structured_spans = self._extract_structured_spans(normalized)
        query_type = self._classify(normalized, structured_spans)

        return QueryPlan(
            original_query=query,
            normalized_query=normalized,
            backend_query=normalized,
            query_type=query_type,
            structured_spans=structured_spans,
        )

    def _normalize(self, query: str) -> str:
        return self._SPACE_RE.sub(" ", query).strip()

    def _extract_structured_spans(self, query: str) -> list[str]:
        spans: list[str] = []
        for token in self._STRUCTURED_TOKEN_RE.findall(query):
            if "_" in token or any(ch.isupper() for ch in token):
                spans.append(token)
        return spans

    def _classify(self, query: str, structured_spans: list[str]) -> QueryType:
        if self._SENTENCE_HINT_RE.search(query):
            return "natural_sentence"
        if "、" in query or " / " in query:
            return "enumeration_or_topic"
        if structured_spans:
            return "keyword_bundle"
        return "keyword_bundle"
