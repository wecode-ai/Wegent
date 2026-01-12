# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Unit tests for Voyage AI embedding implementation.
"""

from unittest.mock import MagicMock, patch

import pytest
import requests

from app.services.rag.embedding.voyage import (
    VoyageEmbedding,
    verify_voyage_connection,
)


class TestVoyageEmbedding:
    """Test cases for VoyageEmbedding class."""

    def test_init_with_defaults(self):
        """Test initialization with default parameters."""
        embedding = VoyageEmbedding(
            api_key="test-api-key",
        )
        assert embedding.model == "voyage-3"
        assert embedding.api_url == VoyageEmbedding.DEFAULT_API_URL
        assert "Authorization" in embedding.headers
        assert embedding.headers["Authorization"] == "Bearer test-api-key"
        assert embedding.headers["Content-Type"] == "application/json"

    def test_init_with_custom_model(self):
        """Test initialization with custom model."""
        embedding = VoyageEmbedding(
            api_key="test-api-key",
            model="voyage-3-lite",
        )
        assert embedding.model == "voyage-3-lite"

    def test_init_with_custom_api_url(self):
        """Test initialization with custom API URL."""
        custom_url = "https://custom.voyage.api/v1/embeddings"
        embedding = VoyageEmbedding(
            api_key="test-api-key",
            api_url=custom_url,
        )
        assert embedding.api_url == custom_url

    def test_init_with_custom_headers(self):
        """Test initialization with additional custom headers."""
        embedding = VoyageEmbedding(
            api_key="test-api-key",
            headers={"X-Custom-Header": "custom-value"},
        )
        assert "X-Custom-Header" in embedding.headers
        assert embedding.headers["X-Custom-Header"] == "custom-value"
        # API key header should still be present
        assert embedding.headers["Authorization"] == "Bearer test-api-key"

    @patch("app.services.rag.embedding.voyage.requests.post")
    def test_get_query_embedding(self, mock_post):
        """Test getting embedding for a query string."""
        # Setup mock response
        mock_response = MagicMock()
        mock_response.json.return_value = {
            "data": [{"embedding": [0.1, 0.2, 0.3] * 341}]  # ~1024 dimensions
        }
        mock_response.raise_for_status = MagicMock()
        mock_post.return_value = mock_response

        embedding = VoyageEmbedding(api_key="test-api-key")
        result = embedding._get_query_embedding("test query")

        assert len(result) == 1023
        mock_post.assert_called_once()
        call_kwargs = mock_post.call_args[1]
        assert call_kwargs["json"]["input_type"] == "query"

    @patch("app.services.rag.embedding.voyage.requests.post")
    def test_get_text_embedding(self, mock_post):
        """Test getting embedding for a text string."""
        # Setup mock response
        mock_response = MagicMock()
        mock_response.json.return_value = {
            "data": [{"embedding": [0.1, 0.2, 0.3] * 341}]
        }
        mock_response.raise_for_status = MagicMock()
        mock_post.return_value = mock_response

        embedding = VoyageEmbedding(api_key="test-api-key")
        result = embedding._get_text_embedding("test document")

        assert len(result) == 1023
        mock_post.assert_called_once()
        call_kwargs = mock_post.call_args[1]
        assert call_kwargs["json"]["input_type"] == "document"

    @patch("app.services.rag.embedding.voyage.requests.post")
    def test_call_api_with_input_type(self, mock_post):
        """Test API call with specific input type."""
        mock_response = MagicMock()
        mock_response.json.return_value = {"data": [{"embedding": [0.1, 0.2, 0.3]}]}
        mock_response.raise_for_status = MagicMock()
        mock_post.return_value = mock_response

        embedding = VoyageEmbedding(api_key="test-api-key")
        embedding._call_api("test text", input_type="query")

        call_kwargs = mock_post.call_args[1]
        assert call_kwargs["json"]["input_type"] == "query"
        assert call_kwargs["json"]["model"] == "voyage-3"
        assert call_kwargs["json"]["input"] == ["test text"]

    @patch("app.services.rag.embedding.voyage.requests.post")
    def test_call_api_with_instance_input_type(self, mock_post):
        """Test API call using instance-level input_type."""
        mock_response = MagicMock()
        mock_response.json.return_value = {"data": [{"embedding": [0.1, 0.2, 0.3]}]}
        mock_response.raise_for_status = MagicMock()
        mock_post.return_value = mock_response

        embedding = VoyageEmbedding(
            api_key="test-api-key",
            input_type="document",
        )
        embedding._call_api("test text")

        call_kwargs = mock_post.call_args[1]
        assert call_kwargs["json"]["input_type"] == "document"

    @patch("app.services.rag.embedding.voyage.requests.post")
    def test_dimension_caching(self, mock_post):
        """Test that embedding dimension is cached after first call."""
        mock_response = MagicMock()
        mock_response.json.return_value = {"data": [{"embedding": [0.1] * 1024}]}
        mock_response.raise_for_status = MagicMock()
        mock_post.return_value = mock_response

        embedding = VoyageEmbedding(api_key="test-api-key")
        assert embedding._dimension is None

        embedding._call_api("test text")
        assert embedding._dimension == 1024


class TestVoyageConnectionVerification:
    """Test cases for verify_voyage_connection function."""

    @patch("app.services.rag.embedding.voyage.requests.post")
    def test_successful_connection(self, mock_post):
        """Test successful connection test."""
        mock_response = MagicMock()
        mock_response.json.return_value = {"data": [{"embedding": [0.1] * 1024}]}
        mock_response.raise_for_status = MagicMock()
        mock_post.return_value = mock_response

        result = verify_voyage_connection(
            api_key="test-api-key",
            model_id="voyage-3",
        )

        assert result["success"] is True
        assert "Successfully connected" in result["message"]
        assert "voyage-3" in result["message"]
        assert "dimension: 1024" in result["message"]

    @patch("app.services.rag.embedding.voyage.requests.post")
    def test_connection_with_custom_base_url(self, mock_post):
        """Test connection with custom base URL."""
        mock_response = MagicMock()
        mock_response.json.return_value = {"data": [{"embedding": [0.1] * 512}]}
        mock_response.raise_for_status = MagicMock()
        mock_post.return_value = mock_response

        result = verify_voyage_connection(
            api_key="test-api-key",
            model_id="voyage-3",
            base_url="https://custom.voyage.api/v1",
        )

        assert result["success"] is True
        # Check that the custom URL was used
        call_args = mock_post.call_args
        assert "https://custom.voyage.api/v1/embeddings" in call_args[0][0]

    @patch("app.services.rag.embedding.voyage.requests.post")
    def test_invalid_api_key(self, mock_post):
        """Test connection with invalid API key."""
        mock_response = MagicMock()
        mock_response.status_code = 401
        mock_response.raise_for_status.side_effect = requests.exceptions.HTTPError(
            response=mock_response
        )
        mock_post.return_value = mock_response

        result = verify_voyage_connection(
            api_key="invalid-key",
            model_id="voyage-3",
        )

        assert result["success"] is False
        assert "Invalid Voyage API key" in result["message"]

    @patch("app.services.rag.embedding.voyage.requests.post")
    def test_model_not_found(self, mock_post):
        """Test connection with non-existent model."""
        mock_response = MagicMock()
        mock_response.status_code = 404
        mock_response.raise_for_status.side_effect = requests.exceptions.HTTPError(
            response=mock_response
        )
        mock_post.return_value = mock_response

        result = verify_voyage_connection(
            api_key="test-api-key",
            model_id="non-existent-model",
        )

        assert result["success"] is False
        assert "not found" in result["message"]

    @patch("app.services.rag.embedding.voyage.requests.post")
    def test_permission_denied(self, mock_post):
        """Test connection with insufficient permissions."""
        mock_response = MagicMock()
        mock_response.status_code = 403
        mock_response.raise_for_status.side_effect = requests.exceptions.HTTPError(
            response=mock_response
        )
        mock_post.return_value = mock_response

        result = verify_voyage_connection(
            api_key="test-api-key",
            model_id="voyage-3",
        )

        assert result["success"] is False
        assert "Permission denied" in result["message"]

    @patch("app.services.rag.embedding.voyage.requests.post")
    def test_bad_request(self, mock_post):
        """Test connection with bad request."""
        mock_response = MagicMock()
        mock_response.status_code = 400
        mock_response.json.return_value = {"detail": "Invalid input format"}
        mock_response.raise_for_status.side_effect = requests.exceptions.HTTPError(
            response=mock_response
        )
        mock_post.return_value = mock_response

        result = verify_voyage_connection(
            api_key="test-api-key",
            model_id="voyage-3",
        )

        assert result["success"] is False
        assert "Bad request" in result["message"]

    @patch("app.services.rag.embedding.voyage.requests.post")
    def test_timeout(self, mock_post):
        """Test connection timeout."""
        mock_post.side_effect = requests.exceptions.Timeout()

        result = verify_voyage_connection(
            api_key="test-api-key",
            model_id="voyage-3",
        )

        assert result["success"] is False
        assert "timeout" in result["message"].lower()

    @patch("app.services.rag.embedding.voyage.requests.post")
    def test_connection_error(self, mock_post):
        """Test connection error."""
        mock_post.side_effect = requests.exceptions.ConnectionError()

        result = verify_voyage_connection(
            api_key="test-api-key",
            model_id="voyage-3",
        )

        assert result["success"] is False
        assert "Failed to connect" in result["message"]

    @patch("app.services.rag.embedding.voyage.requests.post")
    def test_invalid_response_format(self, mock_post):
        """Test handling of invalid response format."""
        mock_response = MagicMock()
        mock_response.json.return_value = {"unexpected": "format"}
        mock_response.raise_for_status = MagicMock()
        mock_post.return_value = mock_response

        result = verify_voyage_connection(
            api_key="test-api-key",
            model_id="voyage-3",
        )

        assert result["success"] is False
        assert "Invalid response format" in result["message"]


class TestVoyageEmbeddingAsync:
    """Test cases for async methods."""

    @pytest.mark.asyncio
    @patch("app.services.rag.embedding.voyage.requests.post")
    async def test_aget_query_embedding(self, mock_post):
        """Test async query embedding."""
        mock_response = MagicMock()
        mock_response.json.return_value = {"data": [{"embedding": [0.1, 0.2, 0.3]}]}
        mock_response.raise_for_status = MagicMock()
        mock_post.return_value = mock_response

        embedding = VoyageEmbedding(api_key="test-api-key")
        result = await embedding._aget_query_embedding("test query")

        assert len(result) == 3
        assert result == [0.1, 0.2, 0.3]
