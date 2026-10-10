# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Query planner that resolves explicit dense and sparse retrieval inputs."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from shared.knowledge_contracts import SearchHints
from shared.knowledge_module.query_planning import HintSource, plan_query


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
        *,
        qa_pair_count: int = 0,
    ) -> QueryPlan:
        resolved = plan_query(query, search_hints, qa_pair_count=qa_pair_count)

        return QueryPlan(
            original_query=query,
            normalized_query=resolved.normalized_query,
            dense_query=resolved.dense_query,
            sparse_query=resolved.sparse_query,
            keywords=resolved.keywords,
            phrases=resolved.phrases,
            hint_source=resolved.hint_source,
        )
