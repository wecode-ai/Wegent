# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Custom embedding implementation for external APIs.
"""

from typing import List, Dict, Optional
import requests
from llama_index.core.base.embeddings.base import BaseEmbedding
from tenacity import retry, stop_after_attempt, wait_exponential


class CustomEmbedding(BaseEmbedding):
    """
    Custom embedding wrapper for external APIs.
    Implements LlamaIndex's BaseEmbedding interface with retry mechanism.
    """

    # Declare fields as class attributes for Pydantic compatibility
    api_url: str
    model: str
    headers: Dict[str, str]
    _dimension: Optional[int] = None

    def __init__(
        self,
        api_url: str,
        model: str,
        headers: Optional[Dict[str, str]] = None,
        embed_batch_size: int = 10,
        **kwargs,
    ):
        super().__init__(
            model_name=model,
            embed_batch_size=embed_batch_size,
            api_url=api_url,
            model=model,
            headers=headers or {},
            **kwargs,
        )

    def _get_query_embedding(self, query: str) -> List[float]:
        """Get embedding for a query string."""
        return self._call_api(query)

    def _get_text_embedding(self, text: str) -> List[float]:
        """Get embedding for a text string."""
        return self._call_api(text)

    async def _aget_query_embedding(self, query: str) -> List[float]:
        """Async version (fallback to sync for simplicity)."""
        return self._get_query_embedding(query)

    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=2, max=10)
    )
    def _call_api(self, text: str) -> List[float]:
        """
        Call external embedding API with retry mechanism.

        Args:
            text: Text to embed

        Returns:
            Embedding vector

        Raises:
            requests.HTTPError: If API call fails after retries
        """
        response = requests.post(
            self.api_url,
            json={"model": self.model, "input": text},
            headers=self.headers,
            timeout=30
        )
        response.raise_for_status()
        embedding = response.json()["data"][0]["embedding"]

        if self._dimension is None:
            self._dimension = len(embedding)

        return embedding
