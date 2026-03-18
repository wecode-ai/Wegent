# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Unit tests for mail token service and API endpoints.
"""

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from wecode.service.mail_token_service import MailTokenService


class TestMailTokenService:
    """Tests for MailTokenService."""

    @pytest.fixture
    def mock_db(self):
        """Create a mock database session."""
        db = MagicMock()
        return db

    @pytest.fixture
    def mock_user(self):
        """Create a mock user with empty preferences."""
        user = MagicMock()
        user.user_name = "testuser"
        user.preferences = json.dumps({})
        return user

    @pytest.fixture
    def mock_user_with_token(self):
        """Create a mock user with an existing mail token."""
        user = MagicMock()
        user.user_name = "testuser"
        user.preferences = json.dumps({"sina_mail_token": "encrypted_token_value"})
        return user

    @pytest.fixture
    def service(self):
        """Create a MailTokenService instance."""
        return MailTokenService()

    def test_get_status_no_token(self, service, mock_user):
        """Test get_status returns False when no token is configured."""
        assert service.get_status(mock_user) is False

    def test_get_status_with_token(self, service, mock_user_with_token):
        """Test get_status returns True when a token is configured."""
        assert service.get_status(mock_user_with_token) is True

    def test_get_status_no_preferences(self, service):
        """Test get_status returns False when preferences is None."""
        user = MagicMock()
        user.preferences = None
        assert service.get_status(user) is False

    def test_get_status_empty_string_preferences(self, service):
        """Test get_status returns False when preferences is empty string."""
        user = MagicMock()
        user.preferences = ""
        assert service.get_status(user) is False

    @pytest.mark.asyncio
    @patch("wecode.service.mail_token_service.httpx.AsyncClient")
    @patch("wecode.service.mail_token_service.encrypt_sensitive_data")
    async def test_exchange_and_save_success(
        self, mock_encrypt, mock_client_cls, service, mock_db, mock_user
    ):
        """Test successful token exchange and save."""
        mock_encrypt.return_value = "encrypted_mail_token"

        # Mock httpx response
        mock_response = MagicMock()
        mock_response.json.return_value = {"token": "real_mail_token"}
        mock_response.raise_for_status = MagicMock()

        mock_client = AsyncMock()
        mock_client.post.return_value = mock_response
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        mock_client_cls.return_value = mock_client

        await service.exchange_and_save(mock_db, mock_user, "client_token_123")

        # Verify KMS was called correctly
        mock_client.post.assert_called_once_with(
            MailTokenService.KMS_URL,
            json={
                "client_token": "client_token_123",
                "user_id": "testuser",
            },
            headers={"Content-Type": "application/json"},
        )

        # Verify encryption was called
        mock_encrypt.assert_called_once_with("real_mail_token")

        # Verify preferences were updated
        mock_db.commit.assert_called_once()
        mock_db.refresh.assert_called_once_with(mock_user)

    @pytest.mark.asyncio
    @patch("wecode.service.mail_token_service.httpx.AsyncClient")
    async def test_exchange_and_save_missing_token(
        self, mock_client_cls, service, mock_db, mock_user
    ):
        """Test exchange fails when KMS response has no token."""
        mock_response = MagicMock()
        mock_response.json.return_value = {"error": "invalid"}
        mock_response.raise_for_status = MagicMock()

        mock_client = AsyncMock()
        mock_client.post.return_value = mock_response
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        mock_client_cls.return_value = mock_client

        with pytest.raises(ValueError, match="KMS response missing 'token' field"):
            await service.exchange_and_save(mock_db, mock_user, "bad_token")

    @pytest.mark.asyncio
    @patch("wecode.service.mail_token_service.httpx.AsyncClient")
    async def test_exchange_and_save_http_error(
        self, mock_client_cls, service, mock_db, mock_user
    ):
        """Test exchange fails when KMS API returns error status."""
        import httpx

        mock_response = MagicMock()
        mock_response.raise_for_status.side_effect = httpx.HTTPStatusError(
            "Server Error",
            request=MagicMock(),
            response=MagicMock(status_code=500),
        )

        mock_client = AsyncMock()
        mock_client.post.return_value = mock_response
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        mock_client_cls.return_value = mock_client

        with pytest.raises(httpx.HTTPStatusError):
            await service.exchange_and_save(mock_db, mock_user, "client_token")

    @pytest.mark.asyncio
    async def test_delete(self, service, mock_db, mock_user_with_token):
        """Test deleting mail token removes it from preferences."""
        await service.delete(mock_db, mock_user_with_token)

        # Verify preferences were updated without sina_mail_token
        updated_prefs = json.loads(mock_user_with_token.preferences)
        assert "sina_mail_token" not in updated_prefs
        mock_db.commit.assert_called_once()

    @pytest.mark.asyncio
    async def test_delete_no_existing_token(self, service, mock_db, mock_user):
        """Test deleting when no token exists is a no-op."""
        await service.delete(mock_db, mock_user)
        mock_db.commit.assert_called_once()

    def test_parse_preferences_dict(self, service):
        """Test _parse_preferences with dict input."""
        user = MagicMock()
        user.preferences = {"key": "value"}
        result = MailTokenService._parse_preferences(user)
        assert result == {"key": "value"}

    def test_parse_preferences_invalid_json(self, service):
        """Test _parse_preferences with invalid JSON returns empty dict."""
        user = MagicMock()
        user.preferences = "not-json"
        result = MailTokenService._parse_preferences(user)
        assert result == {}

    def test_update_preferences_set_value(self, service, mock_db, mock_user):
        """Test _update_preferences sets a new key."""
        MailTokenService._update_preferences(mock_db, mock_user, "test_key", "test_val")
        updated = json.loads(mock_user.preferences)
        assert updated["test_key"] == "test_val"
        mock_db.commit.assert_called_once()

    def test_update_preferences_remove_value(
        self, service, mock_db, mock_user_with_token
    ):
        """Test _update_preferences removes a key when value is None."""
        MailTokenService._update_preferences(
            mock_db, mock_user_with_token, "sina_mail_token", None
        )
        updated = json.loads(mock_user_with_token.preferences)
        assert "sina_mail_token" not in updated
        mock_db.commit.assert_called_once()
