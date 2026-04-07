# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Custom embedding implementation for external APIs."""

import asyncio
from typing import Optional

import requests
from llama_index.core.base.embeddings.base import BaseEmbedding
from tenacity import retry, stop_after_attempt, wait_exponential


class CustomEmbedding(BaseEmbedding):
    """Custom embedding wrapper for OpenAI-compatible endpoints."""

    api_url: str
    model: str
    headers: dict[str, str]
    api_key: Optional[str] = None
    _dimension: Optional[int] = None

    def __init__(
        self,
        *,
        api_url: str,
        model: str,
        headers: dict[str, str] | None = None,
        api_key: str | None = None,
        embed_batch_size: int = 10,
        dimensions: int | None = None,
        **kwargs,
    ) -> None:
        final_headers = headers.copy() if headers else {}
        if api_key and "Authorization" not in final_headers:
            final_headers["Authorization"] = f"Bearer {api_key}"

        super().__init__(
            model_name=model,
            embed_batch_size=embed_batch_size,
            api_url=api_url,
            model=model,
            headers=final_headers,
            api_key=api_key,
            **kwargs,
        )

        if dimensions is not None:
            self._dimension = dimensions

    def _get_query_embedding(self, query: str) -> list[float]:
        return self._call_api(query)

    def _get_text_embedding(self, text: str) -> list[float]:
        return self._call_api(text)

    async def _aget_query_embedding(self, query: str) -> list[float]:
        return await asyncio.to_thread(self._get_query_embedding, query)

    async def _aget_text_embedding(self, text: str) -> list[float]:
        return await asyncio.to_thread(self._get_text_embedding, text)

    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=2, max=10),
    )
    def _call_api(self, text: str) -> list[float]:
        response = requests.post(
            self.api_url,
            json={"model": self.model, "input": text},
            headers=self.headers,
            timeout=30,
        )
        response.raise_for_status()
        embedding = response.json()["data"][0]["embedding"]

        if self._dimension is None:
            self._dimension = len(embedding)

        return embedding
