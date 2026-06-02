# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Typed search hints for experimental query rewrite and sparse planning."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict


class SearchHints(BaseModel):
    """Optional retrieval hints produced by an upstream planner or LLM."""

    model_config = ConfigDict(extra="forbid")

    semantic_query: str | None = None
    keywords: list[str] | None = None
    phrases: list[str] | None = None
