"""Tests for wegent client module."""

import pytest
from unittest.mock import patch, Mock

from wegent.client import WegentClient, APIError, KIND_ALIASES, VALID_KINDS


class TestWegentClient:
    """Tests for WegentClient."""

    def test_normalize_kind_valid(self):
        """Test normalizing valid kind names."""
        client = WegentClient()
        assert client.normalize_kind("ghost") == "ghost"
        assert client.normalize_kind("Ghost") == "ghost"
        assert client.normalize_kind("GHOST") == "ghost"
        assert client.normalize_kind("ghosts") == "ghost"

    def test_normalize_kind_aliases(self):
        """Test kind aliases."""
        client = WegentClient()
        assert client.normalize_kind("gh") == "ghost"
        assert client.normalize_kind("mo") == "model"
        assert client.normalize_kind("sh") == "shell"
        assert client.normalize_kind("bo") == "bot"
        assert client.normalize_kind("te") == "team"
        assert client.normalize_kind("ws") == "workspace"
        assert client.normalize_kind("ta") == "task"

    def test_normalize_kind_invalid(self):
        """Test invalid kind names raise error."""
        client = WegentClient()
        with pytest.raises(ValueError) as exc_info:
            client.normalize_kind("invalid")
        assert "Invalid kind" in str(exc_info.value)

    @patch("wegent.client.requests.request")
    def test_list_resources(self, mock_request):
        """Test listing resources."""
        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "items": [
                {"metadata": {"name": "ghost1", "namespace": "default"}},
                {"metadata": {"name": "ghost2", "namespace": "default"}},
            ]
        }
        mock_request.return_value = mock_response

        client = WegentClient(server="http://test:8000")
        result = client.list_resources("ghost", "default")

        assert len(result) == 2
        assert result[0]["metadata"]["name"] == "ghost1"
        mock_request.assert_called_once()

    @patch("wegent.client.requests.request")
    def test_get_resource(self, mock_request):
        """Test getting a specific resource."""
        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Ghost",
            "metadata": {"name": "my-ghost", "namespace": "default"},
        }
        mock_request.return_value = mock_response

        client = WegentClient(server="http://test:8000")
        result = client.get_resource("ghost", "default", "my-ghost")

        assert result["kind"] == "Ghost"
        assert result["metadata"]["name"] == "my-ghost"

    @patch("wegent.client.requests.request")
    def test_api_error_handling(self, mock_request):
        """Test API error handling."""
        mock_response = Mock()
        mock_response.status_code = 404
        mock_response.json.return_value = {"detail": "Resource not found"}
        mock_request.return_value = mock_response

        client = WegentClient(server="http://test:8000")
        with pytest.raises(APIError) as exc_info:
            client.get_resource("ghost", "default", "nonexistent")

        assert exc_info.value.status_code == 404
        assert "not found" in exc_info.value.message.lower()

    @patch("wegent.client.requests.request")
    def test_connection_error(self, mock_request):
        """Test connection error handling."""
        import requests
        mock_request.side_effect = requests.exceptions.ConnectionError()

        client = WegentClient(server="http://test:8000")
        with pytest.raises(APIError) as exc_info:
            client.list_resources("ghost", "default")

        assert exc_info.value.status_code == 0
        assert "Failed to connect" in exc_info.value.message

    def test_list_resources_with_filter(self):
        """Test filtering resources by name."""
        client = WegentClient()
        with patch.object(client, "_request") as mock_req:
            mock_req.return_value = {
                "items": [
                    {"metadata": {"name": "test-ghost", "namespace": "default"}},
                    {"metadata": {"name": "prod-ghost", "namespace": "default"}},
                ]
            }
            result = client.list_resources("ghost", "default", name_filter="test")
            assert len(result) == 1
            assert result[0]["metadata"]["name"] == "test-ghost"
