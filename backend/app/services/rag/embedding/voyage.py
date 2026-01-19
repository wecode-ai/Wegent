# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Voyage AI embedding implementation.

This module provides a LlamaIndex-compatible embedding wrapper for Voyage AI's
embedding API, supporting models like voyage-3.
"""

import asyncio
from typing import Any, ClassVar, Dict, List, Optional

import requests
from llama_index.core.base.embeddings.base import BaseEmbedding
from tenacity import retry, stop_after_attempt, wait_exponential


class VoyageEmbedding(BaseEmbedding):
    """
    Voyage AI embedding wrapper.
    Implements LlamaIndex's BaseEmbedding interface with retry mechanism.

    Voyage API Reference: https://docs.voyageai.com/reference/embeddings-api
    """

    # Declare fields as class attributes for Pydantic compatibility
    api_url: str
    model: str
    headers: Dict[str, str]
    api_key: Optional[str] = None
    input_type: Optional[str] = None  # 'query' or 'document'
    _dimension: Optional[int] = None

    # Default API endpoint for Voyage AI - use ClassVar to avoid Pydantic field error
    DEFAULT_API_URL: ClassVar[str] = "https://api.voyageai.com/v1/embeddings"

    def __init__(
        self,
        api_key: str,
        model: str = "voyage-3",
        api_url: Optional[str] = None,
        headers: Optional[Dict[str, str]] = None,
        input_type: Optional[str] = None,
        embed_batch_size: int = 10,
        **kwargs,
    ):
        """
        Initialize Voyage embedding client.

        Args:
            api_key: Voyage API key
            model: Model name (default: voyage-3)
            api_url: Custom API endpoint (default: https://api.voyageai.com/v1/embeddings)
            headers: Additional HTTP headers
            input_type: Input type hint ('query' or 'document')
            embed_batch_size: Batch size for embedding requests
        """
        final_api_url = api_url or self.DEFAULT_API_URL

        # Build headers with API key
        final_headers = headers.copy() if headers else {}
        final_headers["Authorization"] = f"Bearer {api_key}"
        final_headers["Content-Type"] = "application/json"

        super().__init__(
            model_name=model,
            embed_batch_size=embed_batch_size,
            api_url=final_api_url,
            model=model,
            headers=final_headers,
            api_key=api_key,
            input_type=input_type,
            **kwargs,
        )

    def _get_query_embedding(self, query: str) -> List[float]:
        """Get embedding for a query string with input_type='query'."""
        return self._call_api(query, input_type="query")

    def _get_text_embedding(self, text: str) -> List[float]:
        """Get embedding for a text string with input_type='document'."""
        return self._call_api(text, input_type="document")

    async def _aget_query_embedding(self, query: str) -> List[float]:
        """Async version - runs sync call in thread pool to avoid blocking."""
        return await asyncio.to_thread(self._get_query_embedding, query)

    @retry(
        stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=2, max=10)
    )
    def _call_api(self, text: str, input_type: Optional[str] = None) -> List[float]:
        """
        Call Voyage embedding API with retry mechanism.

        Args:
            text: Text to embed
            input_type: Optional input type ('query' or 'document')

        Returns:
            Embedding vector

        Raises:
            requests.HTTPError: If API call fails after retries
        """
        payload = {
            "model": self.model,
            "input": [text],  # Voyage expects a list of inputs
        }

        # Add input_type if provided (improves retrieval quality)
        effective_input_type = input_type or self.input_type
        if effective_input_type:
            payload["input_type"] = effective_input_type

        response = requests.post(
            self.api_url,
            json=payload,
            headers=self.headers,
            timeout=30,
        )
        response.raise_for_status()

        result = response.json()
        embedding = result["data"][0]["embedding"]

        if self._dimension is None:
            self._dimension = len(embedding)

        return embedding


def verify_voyage_connection(
    api_key: str,
    model_id: str = "voyage-3",
    base_url: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Verify Voyage API connection by making a simple embedding request.

    Args:
        api_key: Voyage API key
        model_id: Model to test (default: voyage-3)
        base_url: Custom API base URL (optional)

    Returns:
        Dict with 'success' and 'message' keys
    """
    try:
        api_url = base_url or VoyageEmbedding.DEFAULT_API_URL
        if not api_url.endswith("/embeddings"):
            api_url = f"{api_url.rstrip('/')}/embeddings"

        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }

        payload = {
            "model": model_id,
            "input": ["test connection"],
        }

        response = requests.post(
            api_url,
            json=payload,
            headers=headers,
            timeout=30,
        )
        response.raise_for_status()

        result = response.json()
        if "data" in result and len(result["data"]) > 0:
            embedding_dim = len(result["data"][0].get("embedding", []))
            return {
                "success": True,
                "message": f"Successfully connected to Voyage embedding model {model_id} (dimension: {embedding_dim})",
            }
        else:
            return {
                "success": False,
                "message": "Invalid response format from Voyage API",
            }

    except requests.exceptions.HTTPError as e:
        status_code = e.response.status_code
        if status_code == 401:
            message = "Invalid Voyage API key"
        elif status_code == 403:
            message = "Permission denied for Voyage API"
        elif status_code == 404:
            message = f"Model '{model_id}' not found"
        elif status_code == 400:
            # Try to get detailed error message
            try:
                error_detail = e.response.json().get("detail", str(e))
            except Exception:
                error_detail = str(e)
            message = f"Bad request: {error_detail}"
        else:
            message = f"HTTP error {status_code}: {str(e)}"
        return {"success": False, "message": message}

    except requests.exceptions.Timeout:
        return {
            "success": False,
            "message": "Request timeout - Voyage API did not respond",
        }

    except requests.exceptions.ConnectionError:
        return {"success": False, "message": "Failed to connect to Voyage API"}

    except Exception as e:
        return {"success": False, "message": f"Unexpected error: {str(e)}"}
