# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""OpenAI embedding adapter that holds the shared dimension contract."""

from __future__ import annotations

from typing import List

from llama_index.embeddings.openai import OpenAIEmbedding

from knowledge_engine.embedding.contract import ensure_vector_contract


class DimensionCheckedOpenAIEmbedding(OpenAIEmbedding):
    """OpenAI embedding that rejects vectors breaking the declared dimension."""

    def _get_text_embedding(self, text: str) -> List[float]:
        return self._check_vector(super()._get_text_embedding(text))

    async def _aget_text_embedding(self, text: str) -> List[float]:
        return self._check_vector(await super()._aget_text_embedding(text))

    def _get_text_embeddings(self, texts: List[str]) -> List[List[float]]:
        return self._check_vectors(super()._get_text_embeddings(texts))

    async def _aget_text_embeddings(self, texts: List[str]) -> List[List[float]]:
        return self._check_vectors(await super()._aget_text_embeddings(texts))

    def _get_query_embedding(self, query: str) -> List[float]:
        return self._check_vector(super()._get_query_embedding(query))

    async def _aget_query_embedding(self, query: str) -> List[float]:
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
