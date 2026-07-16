# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Query planner that resolves explicit dense and sparse retrieval inputs."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

from knowledge_engine.retrieval.query_planning import build_search_hint_plan
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


class QueryPlanner:
    """Build a retrieval plan from the raw query and optional search hints."""

    def plan(
        self,
        query: str,
        search_hints: SearchHints | dict[str, Any] | None = None,
    ) -> QueryPlan:
        resolved = build_search_hint_plan(query, search_hints)

        return QueryPlan(
            original_query=query,
            normalized_query=resolved.normalized_query,
            dense_query=resolved.dense_query,
            sparse_query=resolved.sparse_query,
            keywords=resolved.keywords,
            phrases=resolved.phrases,
            hint_source=resolved.hint_source,
        )
