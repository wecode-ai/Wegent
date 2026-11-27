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

from knowledge_engine.embedding.contract import ensure_vector_contract
from knowledge_engine.embedding.errors import (
    EmbeddingDimensionMismatchError,
    EmbeddingResponseFormatError,
)
from shared.event_reporting.operations import embedding_fact


class CustomEmbedding(BaseEmbedding):
    """Custom embedding wrapper for OpenAI-compatible endpoints."""

    api_url: str
    model: str
    headers: dict[str, str]
    api_key: Optional[str] = None
    supports_batch_input: bool = False
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
        supports_batch_input: bool = False,
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
            supports_batch_input=supports_batch_input,
            **kwargs,
        )

        if dimensions is not None:
            self._configured_dimension = dimensions
        if encoding_format is not None:
            self._encoding_format = encoding_format

    def _get_query_embedding(self, query: str) -> list[float]:
        return self._call_api(query)

    def _get_text_embedding(self, text: str) -> list[float]:
        return self._call_api(text)

    def _get_text_embeddings(self, texts: list[str]) -> list[list[float]]:
        if not self.supports_batch_input or not texts:
            return super()._get_text_embeddings(texts)
        return self._request_embeddings(texts)

    async def _aget_query_embedding(self, query: str) -> list[float]:
        return await asyncio.to_thread(self._get_query_embedding, query)

    async def _aget_text_embedding(self, text: str) -> list[float]:
        return await asyncio.to_thread(self._get_text_embedding, text)

    async def _aget_text_embeddings(self, texts: list[str]) -> list[list[float]]:
        if not self.supports_batch_input:
            return await super()._aget_text_embeddings(texts)
        return await asyncio.to_thread(self._get_text_embeddings, texts)

    def _call_api(self, text: str) -> list[float]:
        return self._request_embeddings(text)[0]

    @embedding_fact("embedding")
    @retry(
        retry=retry_if_not_exception_type(
            (EmbeddingDimensionMismatchError, EmbeddingResponseFormatError)
        ),
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=2, max=10),
        reraise=True,
    )
    def _request_embeddings(self, inputs: str | list[str]) -> list[list[float]]:
        payload: dict[str, Any] = {"model": self.model, "input": inputs}
        if self._configured_dimension is not None:
            payload["dimensions"] = self._configured_dimension
        if self._encoding_format is not None:
            payload["encoding_format"] = self._encoding_format

        batch_size = len(inputs) if isinstance(inputs, list) else None
        response = requests.post(
            self.api_url,
            json=payload,
            headers=self.headers,
            timeout=30,
        )
        response.raise_for_status()
        return self._parse_embedding_response(response, batch_size=batch_size)

    def _parse_embedding_response(
        self, response: requests.Response, *, batch_size: int | None
    ) -> list[list[float]]:
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
        if not isinstance(response_data, list) or not response_data:
            raise EmbeddingResponseFormatError(
                "Embedding provider returned an invalid response envelope"
            )

        if batch_size is None:
            rows = response_data[:1]
        else:
            if len(response_data) != batch_size:
                raise EmbeddingResponseFormatError(
                    "Embedding provider returned an unexpected embedding count"
                )
            indexed_rows = {}
            for row in response_data:
                index = row.get("index") if isinstance(row, dict) else None
                if (
                    type(index) is not int
                    or not 0 <= index < batch_size
                    or index in indexed_rows
                ):
                    raise EmbeddingResponseFormatError(
                        "Embedding provider returned an invalid embedding index"
                    )
                indexed_rows[index] = row
            rows = [indexed_rows[index] for index in range(batch_size)]

        vectors = [self._parse_embedding_row(row) for row in rows]
        expected_dimension = self._configured_dimension
        if batch_size is not None and expected_dimension is None:
            expected_dimension = len(vectors[0])
        ensure_vector_contract(
            model=self.model, declared=expected_dimension, vectors=vectors
        )
        return vectors

    def _parse_embedding_row(self, row: object) -> list[float]:
        if not isinstance(row, dict) or "embedding" not in row:
            raise EmbeddingResponseFormatError(
                "Embedding provider returned an invalid response envelope"
            )
        response_embedding: object = row["embedding"]
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

        return embedding
