# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import Mock, patch

import pytest
import requests

from app.repository.github_provider import GitHubProvider


@pytest.mark.unit
class TestGitHubProvider:
    """Test GitHubProvider class"""

    def test_validate_token_with_valid_token(self, mocker):
        """Test validate_token with a valid GitHub token"""
        provider = GitHubProvider()

        # Mock requests.get response
        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "id": 12345,
            "login": "testuser",
            "email": "test@example.com",
            "name": "Test User",
        }
        mock_response.raise_for_status = Mock()

        # Mock decrypt_git_token to return the token as-is
        mocker.patch(
            "shared.utils.crypto.decrypt_git_token", return_value="valid_token"
        )
        mocker.patch("shared.utils.crypto.is_token_encrypted", return_value=True)
        mock_get = mocker.patch("requests.get", return_value=mock_response)

        result = provider.validate_token("valid_token", git_domain="github.com")

        assert result["valid"] is True
        assert result["user"]["id"] == 12345
        assert result["user"]["login"] == "testuser"
        assert result["user"]["email"] == "test@example.com"

    def test_validate_token_with_invalid_token(self, mocker):
        """Test validate_token with an invalid GitHub token"""
        provider = GitHubProvider()

        # Mock requests.get to return 401
        mock_response = Mock()
        mock_response.status_code = 401

        # Mock decrypt_git_token to return the token as-is
        mocker.patch(
            "shared.utils.crypto.decrypt_git_token", return_value="invalid_token"
        )
        mocker.patch("shared.utils.crypto.is_token_encrypted", return_value=True)
        mock_get = mocker.patch("requests.get", return_value=mock_response)

        result = provider.validate_token("invalid_token", git_domain="github.com")

        assert result["valid"] is False

    def test_validate_token_with_network_error(self, mocker):
        """Test validate_token handles network errors"""
        provider = GitHubProvider()

        # Mock decrypt_git_token to return the token as-is
        mocker.patch("shared.utils.crypto.decrypt_git_token", return_value="any_token")
        mocker.patch("shared.utils.crypto.is_token_encrypted", return_value=True)

        # Mock requests.get to raise RequestException
        mock_get = mocker.patch(
            "requests.get",
            side_effect=requests.exceptions.RequestException("Network error"),
        )

        # The method should raise HTTPException with 502 status code
        with pytest.raises(Exception) as exc_info:
            provider.validate_token("any_token", git_domain="github.com")

        # Verify it's an HTTPException with status 502
        assert exc_info.value.status_code == 502

    def test_validate_token_with_custom_domain(self, mocker):
        """Test validate_token with custom GitHub domain"""
        provider = GitHubProvider()

        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "id": 99999,
            "login": "enterpriseuser",
            "email": "user@enterprise.com",
        }
        mock_response.raise_for_status = Mock()

        # Mock decrypt_git_token to return the token as-is
        mocker.patch(
            "shared.utils.crypto.decrypt_git_token", return_value="enterprise_token"
        )
        mocker.patch("shared.utils.crypto.is_token_encrypted", return_value=True)
        mock_get = mocker.patch("requests.get", return_value=mock_response)

        result = provider.validate_token(
            "enterprise_token", git_domain="github.enterprise.com"
        )

        assert result["valid"] is True
        # Verify the correct domain was used in the API call
        call_args = mock_get.call_args
        assert "github.enterprise.com" in str(call_args[0][0])

    def test_validate_token_without_email(self, mocker):
        """Test validate_token when user doesn't have public email"""
        provider = GitHubProvider()

        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "id": 54321,
            "login": "no_email_user",
            "email": None,  # No public email
        }
        mock_response.raise_for_status = Mock()

        # Mock decrypt_git_token to return the token as-is
        mocker.patch("shared.utils.crypto.decrypt_git_token", return_value="token")
        mocker.patch("shared.utils.crypto.is_token_encrypted", return_value=True)
        mock_get = mocker.patch("requests.get", return_value=mock_response)

        result = provider.validate_token("token", git_domain="github.com")

        assert result["valid"] is True
        assert result["user"]["email"] is None
