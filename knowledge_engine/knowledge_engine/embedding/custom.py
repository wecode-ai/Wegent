# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Custom embedding implementation for external APIs."""

import asyncio
import base64
import struct
from typing import Any, Optional

import requests
from llama_index.core.base.embeddings.base import BaseEmbedding
from tenacity import (
    retry,
    retry_if_not_exception_type,
    stop_after_attempt,
    wait_exponential,
)

from knowledge_engine.embedding.errors import (
    EmbeddingDimensionMismatchError,
    EmbeddingResponseFormatError,
)


class CustomEmbedding(BaseEmbedding):
    """Custom embedding wrapper for OpenAI-compatible endpoints."""

    api_url: str
    model: str
    headers: dict[str, str]
    api_key: Optional[str] = None
    _dimension: Optional[int] = None
    _configured_dimension: Optional[int] = None
    _encoding_format: Optional[str] = None

    def __init__(
        self,
        *,
        api_url: str,
        model: str,
        headers: dict[str, str] | None = None,
        api_key: str | None = None,
        embed_batch_size: int = 10,
        dimensions: int | None = None,
        encoding_format: str | None = None,
        **kwargs: Any,
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
            self._configured_dimension = dimensions
        if encoding_format is not None:
            self._encoding_format = encoding_format

    def _get_query_embedding(self, query: str) -> list[float]:
        return self._call_api(query)

    def _get_text_embedding(self, text: str) -> list[float]:
        return self._call_api(text)

    async def _aget_query_embedding(self, query: str) -> list[float]:
        return await asyncio.to_thread(self._get_query_embedding, query)

    async def _aget_text_embedding(self, text: str) -> list[float]:
        return await asyncio.to_thread(self._get_text_embedding, text)

    @retry(
        retry=retry_if_not_exception_type(
            (EmbeddingDimensionMismatchError, EmbeddingResponseFormatError)
        ),
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=2, max=10),
        reraise=True,
    )
    def _call_api(self, text: str) -> list[float]:
        payload: dict[str, Any] = {"model": self.model, "input": text}
        if self._configured_dimension is not None:
            payload["dimensions"] = self._configured_dimension
        if self._encoding_format is not None:
            payload["encoding_format"] = self._encoding_format

        response = requests.post(
            self.api_url,
            json=payload,
            headers=self.headers,
            timeout=30,
        )
        response.raise_for_status()

        return self._parse_embedding_response(response)

    def _parse_embedding_response(self, response: requests.Response) -> list[float]:
        try:
            response_payload: object = response.json()
        except ValueError as exc:
            raise EmbeddingResponseFormatError(
                "Embedding provider returned an invalid response envelope"
            ) from exc

        if not isinstance(response_payload, dict):
            raise EmbeddingResponseFormatError(
                "Embedding provider returned an invalid response envelope"
            )
        response_data = response_payload.get("data")
        if (
            not isinstance(response_data, list)
            or not response_data
            or not isinstance(response_data[0], dict)
            or "embedding" not in response_data[0]
        ):
            raise EmbeddingResponseFormatError(
                "Embedding provider returned an invalid response envelope"
            )
        response_embedding: object = response_data[0]["embedding"]

        if self._encoding_format == "base64":
            if not isinstance(response_embedding, str):
                raise EmbeddingResponseFormatError(
                    "Embedding provider returned a non-string response; "
                    "expected a base64 string"
                )
            try:
                raw_embedding = base64.b64decode(response_embedding, validate=True)
            except ValueError as exc:
                raise EmbeddingResponseFormatError(
                    "Invalid base64 embedding response"
                ) from exc
            if len(raw_embedding) % 4 != 0:
                raise EmbeddingResponseFormatError(
                    "Invalid base64 embedding byte length"
                )
            embedding = [value[0] for value in struct.iter_unpack("<f", raw_embedding)]
        else:
            if not isinstance(response_embedding, list) or any(
                isinstance(value, bool) or not isinstance(value, (int, float))
                for value in response_embedding
            ):
                raise EmbeddingResponseFormatError(
                    "Embedding provider returned an invalid response; "
                    "expected a numeric embedding array"
                )
            embedding = [float(value) for value in response_embedding]

        actual_dimension = len(embedding)
        if (
            self._configured_dimension is not None
            and actual_dimension != self._configured_dimension
        ):
            raise EmbeddingDimensionMismatchError(
                model=self.model,
                expected=self._configured_dimension,
                actual=actual_dimension,
            )
        if self._dimension is None:
            self._dimension = actual_dimension

        return embedding
