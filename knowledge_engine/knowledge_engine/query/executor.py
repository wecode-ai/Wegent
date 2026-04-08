# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import asyncio
from typing import Any

from shared.models import RuntimeRetrievalConfig


class QueryExecutor:
    """Backend-agnostic RAG query executor."""

    def __init__(self, *, storage_backend, embed_model) -> None:
        self.storage_backend = storage_backend
        self.embed_model = embed_model

    async def execute(
        self,
        *,
        knowledge_id: str,
        query: str,
        retrieval_config: RuntimeRetrievalConfig | dict[str, Any],
        metadata_condition: dict[str, Any] | None = None,
        user_id: int | None = None,
    ) -> dict[str, Any]:
        retrieval_setting = self._normalize_retrieval_setting(retrieval_config)
        kwargs: dict[str, Any] = {}
        if user_id is not None:
            kwargs["user_id"] = user_id

        return await asyncio.to_thread(
            self.storage_backend.retrieve,
            knowledge_id=knowledge_id,
            query=query,
            embed_model=self.embed_model,
            retrieval_setting=retrieval_setting,
            metadata_condition=metadata_condition,
            **kwargs,
        )

    @staticmethod
    def _normalize_retrieval_setting(
        retrieval_config: RuntimeRetrievalConfig | dict[str, Any],
    ) -> dict[str, Any]:
        if isinstance(retrieval_config, RuntimeRetrievalConfig):
            config = retrieval_config.model_dump(exclude_none=True)
        else:
            config = dict(retrieval_config)

        retrieval_setting = {
            "top_k": config.get("top_k") or 20,
            "score_threshold": (
                config.get("score_threshold")
                if config.get("score_threshold") is not None
                else 0.7
            ),
            "retrieval_mode": config.get("retrieval_mode") or "vector",
        }
        if "vector_weight" in config:
            retrieval_setting["vector_weight"] = config["vector_weight"]
        if "keyword_weight" in config:
            retrieval_setting["keyword_weight"] = config["keyword_weight"]
        return retrieval_setting
