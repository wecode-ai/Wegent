# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""OpenAI embedding adapter that holds the shared dimension contract."""

from __future__ import annotations

from collections.abc import Callable
from functools import partial
from typing import Any, List

from llama_index.embeddings.openai import OpenAIEmbedding

from knowledge_engine.diagnostics import timed_stage
from knowledge_engine.embedding.contract import ensure_vector_contract
from knowledge_engine.embedding.diagnostics import (
    log_embedding_attempt,
    log_embedding_retry,
)


class DimensionCheckedOpenAIEmbedding(OpenAIEmbedding):
    """OpenAI embedding that rejects vectors breaking the declared dimension."""

    def _create_retry_decorator(self) -> Callable:
        """Keep the provider's retry policy and add sanitized adapter diagnostics."""
        decorate = super()._create_retry_decorator()

        def with_diagnostics(fn: Callable[..., Any]) -> Callable[..., Any]:
            wrapped = decorate(fn)
            return wrapped.retry_with(
                before=partial(log_embedding_attempt, model=self.model_name),
                before_sleep=partial(log_embedding_retry, model=self.model_name),
            )

        return with_diagnostics

    def _get_text_embedding(self, text: str) -> List[float]:
        return self._check_vector(super()._get_text_embedding(text))

    async def _aget_text_embedding(self, text: str) -> List[float]:
        return self._check_vector(await super()._aget_text_embedding(text))

    def _get_text_embeddings(self, texts: List[str]) -> List[List[float]]:
        return self._check_vectors(super()._get_text_embeddings(texts))

    async def _aget_text_embeddings(self, texts: List[str]) -> List[List[float]]:
        return self._check_vectors(await super()._aget_text_embeddings(texts))

    def _get_query_embedding(self, query: str) -> List[float]:
        with timed_stage("embedding_call", model=self.model_name):
            return self._check_vector(super()._get_query_embedding(query))

    async def _aget_query_embedding(self, query: str) -> List[float]:
        with timed_stage("embedding_call", model=self.model_name):
            return self._check_vector(await super()._aget_query_embedding(query))

    def _check_vectors(self, vectors: List[List[float]]) -> List[List[float]]:
        ensure_vector_contract(
            model=self.model_name,
            declared=self.dimensions,
            vectors=vectors,
        )
        return vectors

    def _check_vector(self, vector: List[float]) -> List[float]:
        return self._check_vectors([vector])[0]
