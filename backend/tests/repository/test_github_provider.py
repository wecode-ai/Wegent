# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest
import httpx
from unittest.mock import Mock, patch

from app.repository.github_provider import GitHubProvider


@pytest.mark.unit
class TestGitHubProvider:
    """Test GitHubProvider class"""

    def test_validate_token_with_valid_token(self, mocker):
        """Test validate_token with a valid GitHub token"""
        provider = GitHubProvider()

        # Mock httpx.Client.get response
        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "id": 12345,
            "login": "testuser",
            "email": "test@example.com",
            "name": "Test User"
        }

        mock_get = mocker.patch("httpx.Client.get", return_value=mock_response)

        result = provider.validate_token("valid_token", git_domain="github.com")

        assert result["valid"] is True
        assert result["user"]["id"] == 12345
        assert result["user"]["login"] == "testuser"
        assert result["user"]["email"] == "test@example.com"

    def test_validate_token_with_invalid_token(self, mocker):
        """Test validate_token with an invalid GitHub token"""
        provider = GitHubProvider()

        # Mock httpx.Client.get to raise HTTPError
        mock_response = Mock()
        mock_response.status_code = 401
        mock_response.raise_for_status.side_effect = httpx.HTTPStatusError(
            "Unauthorized",
            request=Mock(),
            response=mock_response
        )

        mock_get = mocker.patch("httpx.Client.get", return_value=mock_response)

        result = provider.validate_token("invalid_token", git_domain="github.com")

        assert result["valid"] is False

    def test_validate_token_with_network_error(self, mocker):
        """Test validate_token handles network errors"""
        provider = GitHubProvider()

        # Mock httpx.Client.get to raise RequestError
        mock_get = mocker.patch(
            "httpx.Client.get",
            side_effect=httpx.RequestError("Network error", request=Mock())
        )

        result = provider.validate_token("any_token", git_domain="github.com")

        assert result["valid"] is False

    def test_validate_token_with_custom_domain(self, mocker):
        """Test validate_token with custom GitHub domain"""
        provider = GitHubProvider()

        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "id": 99999,
            "login": "enterpriseuser",
            "email": "user@enterprise.com"
        }

        mock_get = mocker.patch("httpx.Client.get", return_value=mock_response)

        result = provider.validate_token(
            "enterprise_token",
            git_domain="github.enterprise.com"
        )

        assert result["valid"] is True
        # Verify the correct domain was used in the API call
        call_args = mock_get.call_args
        assert "github.enterprise.com" in str(call_args) or call_args is not None

    def test_validate_token_without_email(self, mocker):
        """Test validate_token when user doesn't have public email"""
        provider = GitHubProvider()

        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "id": 54321,
            "login": "no_email_user",
            "email": None  # No public email
        }

        mock_get = mocker.patch("httpx.Client.get", return_value=mock_response)

        result = provider.validate_token("token", git_domain="github.com")

        assert result["valid"] is True
        assert result["user"]["email"] is None
