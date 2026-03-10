# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Custom embedding implementation for external APIs.
"""

import asyncio
from typing import Dict, List, Optional

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
    api_key: Optional[str] = None
    _dimension: Optional[int] = None

    def __init__(
        self,
        api_url: str,
        model: str,
        headers: Optional[Dict[str, str]] = None,
        api_key: Optional[str] = None,
        embed_batch_size: int = 10,
        dimensions: Optional[int] = None,
        **kwargs,
    ):
        # Merge api_key into headers if provided
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

        # Set dimension from Model CRD config if provided
        # This allows Milvus to create collections with the correct dimension
        if dimensions is not None:
            self._dimension = dimensions

    def _get_query_embedding(self, query: str) -> List[float]:
        """Get embedding for a query string."""
        return self._call_api(query)

    def _get_text_embedding(self, text: str) -> List[float]:
        """Get embedding for a text string."""
        return self._call_api(text)

    async def _aget_query_embedding(self, query: str) -> List[float]:
        """Async version - runs sync call in thread pool to avoid blocking."""
        return await asyncio.to_thread(self._get_query_embedding, query)

    @retry(
        stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=2, max=10)
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
        # DEBUG: Log request details for troubleshooting
        import logging

        logger = logging.getLogger(__name__)
        logger.info(
            f"[Embedding API Request] URL: {self.api_url}, "
            f"Model: {self.model}, Text length: {len(text)}, "
            f"Headers keys: {list(self.headers.keys())}"
        )

        # Truncate text for logging if too long
        text_preview = text[:200] + "..." if len(text) > 200 else text
        logger.debug(f"[Embedding API Request] Text preview: {text_preview}")

        try:
            response = requests.post(
                self.api_url,
                json={"model": self.model, "input": text},
                headers=self.headers,
                timeout=30,
            )

            # DEBUG: Log response details before raising
            logger.info(
                f"[Embedding API Response] Status: {response.status_code}, "
                f"Content-Type: {response.headers.get('content-type', 'unknown')}"
            )

            if response.status_code >= 400:
                # Log error response body for debugging
                try:
                    error_body = response.text[:500]  # Limit error body size
                    logger.error(
                        f"[Embedding API Error] Status {response.status_code}: {error_body}"
                    )
                except Exception as e:
                    logger.error(
                        f"[Embedding API Error] Could not read error body: {e}"
                    )

            response.raise_for_status()
            response_data = response.json()

            # Validate response structure
            if "data" not in response_data:
                logger.error(
                    f"[Embedding API Error] Missing 'data' in response: {response_data.keys()}"
                )
                raise ValueError(f"Invalid response format: missing 'data' field")

            if not response_data["data"] or len(response_data["data"]) == 0:
                logger.error(f"[Embedding API Error] Empty data array in response")
                raise ValueError(f"Invalid response format: empty data array")

            embedding = response_data["data"][0]["embedding"]

            if self._dimension is None:
                self._dimension = len(embedding)
                logger.info(
                    f"[Embedding API] Detected embedding dimension: {self._dimension}"
                )

            logger.info(
                f"[Embedding API] Successfully got embedding, dimension: {len(embedding)}"
            )
            return embedding

        except requests.exceptions.Timeout:
            logger.error(f"[Embedding API Error] Request timeout after 30s")
            raise
        except requests.exceptions.ConnectionError as e:
            logger.error(f"[Embedding API Error] Connection error: {e}")
            raise
        except Exception as e:
            logger.error(
                f"[Embedding API Error] Unexpected error: {type(e).__name__}: {e}"
            )
            raise
