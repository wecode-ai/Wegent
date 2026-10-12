# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Stubs shared by the Milvus backend and dimension contract tests."""

from typing import Any, Dict, List, Optional
from unittest.mock import patch

from llama_index.core.base.embeddings.base import BaseEmbedding
from pydantic import PrivateAttr


class StubEmbeddingModel(BaseEmbedding):
    """Embedding model with an explicit declared-dimension contract."""

    _configured_dimension: Optional[int] = PrivateAttr(default=None)
    _vector_dimension: int = PrivateAttr(default=4)
    _text_batches: List[List[str]] = PrivateAttr(default_factory=list)
    _query_requests: List[str] = PrivateAttr(default_factory=list)
    _batch_response: Optional[List[List[float]]] = PrivateAttr(default=None)

    def __init__(
        self,
        *,
        declared_dimension: Optional[int],
        vector_dimension: int,
        embed_batch_size: int = 10,
    ) -> None:
        super().__init__(
            model_name="stub-embedding-model",
            embed_batch_size=embed_batch_size,
        )
        self._vector_dimension = vector_dimension
        self._configured_dimension = None
        if declared_dimension is not None:
            self._configured_dimension = declared_dimension

    @property
    def text_batches(self) -> List[List[str]]:
        return self._text_batches

    @property
    def query_requests(self) -> List[str]:
        return self._query_requests

    @property
    def batch_response(self) -> Optional[List[List[float]]]:
        return self._batch_response

    @batch_response.setter
    def batch_response(self, vectors: Optional[List[List[float]]]) -> None:
        """Override what the provider returns for the next batch."""
        self._batch_response = vectors

    def _get_text_embedding(self, text: str) -> List[float]:
        return [0.5] * self._vector_dimension

    async def _aget_text_embedding(self, text: str) -> List[float]:
        return self._get_text_embedding(text)

    def _get_text_embeddings(self, texts: List[str]) -> List[List[float]]:
        self._text_batches.append(list(texts))
        if self._batch_response is not None:
            return self._batch_response
        return [[0.5] * self._vector_dimension for _ in texts]

    def _get_query_embedding(self, query: str) -> List[float]:
        self._query_requests.append(query)
        return [0.5] * self._vector_dimension

    async def _aget_query_embedding(self, query: str) -> List[float]:
        return self._get_query_embedding(query)


def collection_description(dimension: int) -> Dict[str, Any]:
    return {
        "fields": [
            {"name": "pk", "params": {}},
            {"name": "embedding", "params": {"dim": dimension}},
            {"name": "sparse_embedding", "params": {}},
        ]
    }


def patch_collection(dimension: Optional[int] = 1536) -> Any:
    """Patch the collection lookup that guards every query and write."""
    stub: Dict[str, Any] = {
        "return_value.has_collection.return_value": dimension is not None,
    }
    if dimension is not None:
        stub["return_value.describe_collection.return_value"] = collection_description(
            dimension
        )
    return patch("knowledge_engine.storage.milvus_backend.MilvusClient", **stub)
