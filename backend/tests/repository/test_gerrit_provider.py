# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Tests for GerritProvider authentication type handling
"""

from unittest.mock import AsyncMock, Mock, patch

import pytest
import requests
from requests.auth import HTTPBasicAuth, HTTPDigestAuth

from app.repository.gerrit_provider import GerritProvider


@pytest.fixture
def mock_user():
    """Create a mock user object with Gerrit git_info"""
    user = Mock()
    user.id = 1
    user.user_name = "testuser"
    user.git_info = [
        {
            "type": "gerrit",
            "git_domain": "gerrit.example.com",
            "git_token": "test_password",
            "user_name": "testuser",
            "auth_type": "digest",
        }
    ]
    return user


@pytest.fixture
def mock_user_basic_auth():
    """Create a mock user object with Gerrit git_info using basic auth"""
    user = Mock()
    user.id = 1
    user.user_name = "testuser"
    user.git_info = [
        {
            "type": "gerrit",
            "git_domain": "gerrit.example.com",
            "git_token": "test_password",
            "user_name": "testuser",
            "auth_type": "basic",
        }
    ]
    return user


@pytest.fixture
def mock_user_no_auth_type():
    """Create a mock user object with Gerrit git_info without auth_type (should default to digest)"""
    user = Mock()
    user.id = 1
    user.user_name = "testuser"
    user.git_info = [
        {
            "type": "gerrit",
            "git_domain": "gerrit.example.com",
            "git_token": "test_password",
            "user_name": "testuser",
            # No auth_type specified - should default to "digest"
        }
    ]
    return user


@pytest.fixture
def gerrit_provider():
    """Create a GerritProvider instance"""
    return GerritProvider()


@pytest.mark.unit
class TestGerritProviderAuthType:
    """Test GerritProvider authentication type handling"""

    def test_get_git_infos_includes_auth_type(self, gerrit_provider, mock_user):
        """Test that _get_git_infos includes auth_type in returned entries"""
        entries = gerrit_provider._get_git_infos(mock_user)

        assert len(entries) == 1
        assert entries[0]["auth_type"] == "digest"

    def test_get_git_infos_defaults_auth_type_to_digest(
        self, gerrit_provider, mock_user_no_auth_type
    ):
        """Test that _get_git_infos defaults auth_type to 'digest' when not specified"""
        entries = gerrit_provider._get_git_infos(mock_user_no_auth_type)

        assert len(entries) == 1
        assert entries[0]["auth_type"] == "digest"

    def test_get_git_infos_with_basic_auth(self, gerrit_provider, mock_user_basic_auth):
        """Test that _get_git_infos correctly retrieves basic auth type"""
        entries = gerrit_provider._get_git_infos(mock_user_basic_auth)

        assert len(entries) == 1
        assert entries[0]["auth_type"] == "basic"

    def test_make_request_uses_digest_auth_by_default(self, gerrit_provider, mocker):
        """Test that _make_request uses HTTPDigestAuth by default"""
        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.text = ")]}'{}".encode("utf-8").decode()
        mock_response.raise_for_status = Mock()

        mock_request = mocker.patch("requests.request", return_value=mock_response)

        gerrit_provider._make_request(
            method="GET",
            url="https://gerrit.example.com/a/accounts/self",
            username="testuser",
            http_password="testpassword",
            # No auth_type specified - should default to digest
        )

        # Verify the request was called
        mock_request.assert_called_once()
        call_args = mock_request.call_args
        # Check that the auth parameter is HTTPDigestAuth
        auth = call_args[1]["auth"]
        assert isinstance(auth, HTTPDigestAuth)

    def test_make_request_uses_digest_auth_when_specified(
        self, gerrit_provider, mocker
    ):
        """Test that _make_request uses HTTPDigestAuth when auth_type='digest'"""
        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.text = ")]}'{}".encode("utf-8").decode()
        mock_response.raise_for_status = Mock()

        mock_request = mocker.patch("requests.request", return_value=mock_response)

        gerrit_provider._make_request(
            method="GET",
            url="https://gerrit.example.com/a/accounts/self",
            username="testuser",
            http_password="testpassword",
            auth_type="digest",
        )

        mock_request.assert_called_once()
        call_args = mock_request.call_args
        auth = call_args[1]["auth"]
        assert isinstance(auth, HTTPDigestAuth)

    def test_make_request_uses_basic_auth_when_specified(self, gerrit_provider, mocker):
        """Test that _make_request uses HTTPBasicAuth when auth_type='basic'"""
        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.text = ")]}'{}".encode("utf-8").decode()
        mock_response.raise_for_status = Mock()

        mock_request = mocker.patch("requests.request", return_value=mock_response)

        gerrit_provider._make_request(
            method="GET",
            url="https://gerrit.example.com/a/accounts/self",
            username="testuser",
            http_password="testpassword",
            auth_type="basic",
        )

        mock_request.assert_called_once()
        call_args = mock_request.call_args
        auth = call_args[1]["auth"]
        assert isinstance(auth, HTTPBasicAuth)


@pytest.mark.unit
class TestGerritProviderValidateToken:
    """Test GerritProvider token validation with auth_type"""

    def test_validate_token_with_digest_auth(self, gerrit_provider, mocker):
        """Test validate_token with digest authentication"""
        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.text = ')]}\'{"_account_id": 12345, "name": "Test User", "email": "test@example.com", "user_name": "testuser"}'
        mock_response.raise_for_status = Mock()

        mocker.patch(
            "shared.utils.crypto.decrypt_git_token", return_value="test_password"
        )
        mocker.patch("shared.utils.crypto.is_token_encrypted", return_value=True)
        mock_request = mocker.patch("requests.request", return_value=mock_response)

        result = gerrit_provider.validate_token(
            "test_password",
            git_domain="gerrit.example.com",
            user_name="testuser",
            auth_type="digest",
        )

        assert result["valid"] is True
        assert result["user"]["id"] == 12345
        assert result["user"]["email"] == "test@example.com"

        # Verify HTTPDigestAuth was used
        call_args = mock_request.call_args
        auth = call_args[1]["auth"]
        assert isinstance(auth, HTTPDigestAuth)

    def test_validate_token_with_basic_auth(self, gerrit_provider, mocker):
        """Test validate_token with basic authentication"""
        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.text = ')]}\'{"_account_id": 12345, "name": "Test User", "email": "test@example.com", "user_name": "testuser"}'
        mock_response.raise_for_status = Mock()

        mocker.patch(
            "shared.utils.crypto.decrypt_git_token", return_value="test_password"
        )
        mocker.patch("shared.utils.crypto.is_token_encrypted", return_value=True)
        mock_request = mocker.patch("requests.request", return_value=mock_response)

        result = gerrit_provider.validate_token(
            "test_password",
            git_domain="gerrit.example.com",
            user_name="testuser",
            auth_type="basic",
        )

        assert result["valid"] is True
        assert result["user"]["id"] == 12345
        assert result["user"]["email"] == "test@example.com"

        # Verify HTTPBasicAuth was used
        call_args = mock_request.call_args
        auth = call_args[1]["auth"]
        assert isinstance(auth, HTTPBasicAuth)

    def test_validate_token_defaults_to_digest_auth(self, gerrit_provider, mocker):
        """Test validate_token defaults to digest auth when auth_type not specified"""
        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.text = ')]}\'{"_account_id": 12345, "name": "Test User", "email": "test@example.com", "user_name": "testuser"}'
        mock_response.raise_for_status = Mock()

        mocker.patch(
            "shared.utils.crypto.decrypt_git_token", return_value="test_password"
        )
        mocker.patch("shared.utils.crypto.is_token_encrypted", return_value=True)
        mock_request = mocker.patch("requests.request", return_value=mock_response)

        result = gerrit_provider.validate_token(
            "test_password",
            git_domain="gerrit.example.com",
            user_name="testuser",
            # No auth_type specified - should default to digest
        )

        assert result["valid"] is True

        # Verify HTTPDigestAuth was used (default)
        call_args = mock_request.call_args
        auth = call_args[1]["auth"]
        assert isinstance(auth, HTTPDigestAuth)

    def test_validate_token_returns_auth_failed_error_on_401(
        self, gerrit_provider, mocker
    ):
        """Test validate_token returns auth_failed error with message on 401"""
        # Create a RequestException with a 401 response
        mock_response = Mock()
        mock_response.status_code = 401

        mock_exception = requests.exceptions.HTTPError("401 Unauthorized")
        mock_exception.response = mock_response

        mocker.patch(
            "shared.utils.crypto.decrypt_git_token", return_value="test_password"
        )
        mocker.patch("shared.utils.crypto.is_token_encrypted", return_value=True)
        mocker.patch("requests.request", side_effect=mock_exception)

        result = gerrit_provider.validate_token(
            "test_password",
            git_domain="gerrit.example.com",
            user_name="testuser",
            auth_type="basic",
        )

        assert result["valid"] is False
        assert result["error"] == "auth_failed"
        assert "basic" in result["message"]
        assert "Authentication failed" in result["message"]

    def test_validate_token_error_message_includes_auth_type(
        self, gerrit_provider, mocker
    ):
        """Test that 401 error message includes the auth_type for debugging"""
        mock_response = Mock()
        mock_response.status_code = 401

        mock_exception = requests.exceptions.HTTPError("401 Unauthorized")
        mock_exception.response = mock_response

        mocker.patch(
            "shared.utils.crypto.decrypt_git_token", return_value="test_password"
        )
        mocker.patch("shared.utils.crypto.is_token_encrypted", return_value=True)
        mocker.patch("requests.request", side_effect=mock_exception)

        # Test with digest auth
        result = gerrit_provider.validate_token(
            "test_password",
            git_domain="gerrit.example.com",
            user_name="testuser",
            auth_type="digest",
        )

        assert result["valid"] is False
        assert "digest" in result["message"]


@pytest.mark.unit
class TestGerritProviderAsyncMethods:
    """Test GerritProvider async methods with auth_type"""

    @pytest.mark.asyncio
    async def test_make_request_async_uses_basic_auth(self, gerrit_provider, mocker):
        """Test that _make_request_async uses HTTPBasicAuth when auth_type='basic'"""
        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.text = ")]}'{}".encode("utf-8").decode()
        mock_response.raise_for_status = Mock()

        captured_auth = [None]

        def capture_request(*args, **kwargs):
            captured_auth[0] = kwargs.get("auth")
            return mock_response

        mocker.patch(
            "asyncio.to_thread",
            side_effect=lambda func, *args, **kwargs: capture_request(**kwargs),
        )

        await gerrit_provider._make_request_async(
            method="GET",
            url="https://gerrit.example.com/a/projects/",
            username="testuser",
            http_password="testpassword",
            auth_type="basic",
        )

        assert isinstance(captured_auth[0], HTTPBasicAuth)

    @pytest.mark.asyncio
    async def test_make_request_async_uses_digest_auth_by_default(
        self, gerrit_provider, mocker
    ):
        """Test that _make_request_async uses HTTPDigestAuth by default"""
        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.text = ")]}'{}".encode("utf-8").decode()
        mock_response.raise_for_status = Mock()

        captured_auth = [None]

        def capture_request(*args, **kwargs):
            captured_auth[0] = kwargs.get("auth")
            return mock_response

        mocker.patch(
            "asyncio.to_thread",
            side_effect=lambda func, *args, **kwargs: capture_request(**kwargs),
        )

        await gerrit_provider._make_request_async(
            method="GET",
            url="https://gerrit.example.com/a/projects/",
            username="testuser",
            http_password="testpassword",
            # No auth_type specified - should default to digest
        )

        assert isinstance(captured_auth[0], HTTPDigestAuth)


@pytest.mark.unit
class TestGerritProviderGetBranches:
    """Test GerritProvider get_branches with auth_type"""

    @pytest.mark.asyncio
    async def test_get_branches_uses_auth_type_from_git_info(
        self, gerrit_provider, mock_user_basic_auth, mocker
    ):
        """Test that get_branches uses auth_type from git_info"""
        # Mock the _make_request method to capture auth_type
        captured_auth_type = [None]

        def mock_make_request(*args, **kwargs):
            captured_auth_type[0] = kwargs.get("auth_type")
            mock_response = Mock()
            mock_response.status_code = 200
            mock_response.text = (
                ')]}\'\n[{"ref": "refs/heads/main"}, {"ref": "refs/heads/develop"}]'
            )
            mock_response.raise_for_status = Mock()
            return mock_response

        mocker.patch.object(
            gerrit_provider, "_make_request", side_effect=mock_make_request
        )
        mocker.patch.object(gerrit_provider, "_get_default_branch", return_value="main")

        await gerrit_provider.get_branches(
            mock_user_basic_auth, "test-project", "gerrit.example.com"
        )

        # Verify auth_type="basic" was passed to _make_request
        assert captured_auth_type[0] == "basic"


@pytest.mark.unit
class TestGerritProviderCreateChange:
    """Test GerritProvider create_change with auth_type"""

    @pytest.mark.asyncio
    async def test_create_change_uses_auth_type_from_git_info(
        self, gerrit_provider, mock_user_basic_auth, mocker
    ):
        """Test that create_change uses auth_type from git_info"""
        captured_auth_type = [None]

        def mock_make_request(*args, **kwargs):
            captured_auth_type[0] = kwargs.get("auth_type")
            mock_response = Mock()
            mock_response.status_code = 200
            mock_response.text = ')]}\'{"id": "test~change", "change_id": "Iabcd1234", "_number": 123, "subject": "Test Change", "status": "DRAFT"}'
            mock_response.raise_for_status = Mock()
            return mock_response

        mocker.patch.object(
            gerrit_provider, "_make_request", side_effect=mock_make_request
        )

        await gerrit_provider.create_change(
            mock_user_basic_auth,
            "test-project",
            "main",
            "Test Change",
            "gerrit.example.com",
        )

        # Verify auth_type="basic" was passed to _make_request
        assert captured_auth_type[0] == "basic"


@pytest.mark.unit
class TestGerritProviderGetDefaultBranch:
    """Test GerritProvider _get_default_branch with auth_type"""

    def test_get_default_branch_passes_auth_type(self, gerrit_provider, mocker):
        """Test that _get_default_branch passes auth_type to _make_request"""
        captured_auth_type = [None]

        def mock_make_request(*args, **kwargs):
            captured_auth_type[0] = kwargs.get("auth_type")
            mock_response = Mock()
            mock_response.status_code = 200
            mock_response.text = ')]}\'"refs/heads/main"'
            mock_response.raise_for_status = Mock()
            return mock_response

        mocker.patch.object(
            gerrit_provider, "_make_request", side_effect=mock_make_request
        )

        result = gerrit_provider._get_default_branch(
            "test-project",
            "gerrit.example.com",
            "testuser",
            "testpassword",
            auth_type="basic",
        )

        assert result == "main"
        assert captured_auth_type[0] == "basic"

    def test_get_default_branch_defaults_to_digest(self, gerrit_provider, mocker):
        """Test that _get_default_branch defaults to digest auth"""
        captured_auth_type = [None]

        def mock_make_request(*args, **kwargs):
            captured_auth_type[0] = kwargs.get("auth_type")
            mock_response = Mock()
            mock_response.status_code = 200
            mock_response.text = ')]}\'"refs/heads/master"'
            mock_response.raise_for_status = Mock()
            return mock_response

        mocker.patch.object(
            gerrit_provider, "_make_request", side_effect=mock_make_request
        )

        result = gerrit_provider._get_default_branch(
            "test-project",
            "gerrit.example.com",
            "testuser",
            "testpassword",
            # No auth_type specified - should default to digest
        )

        assert result == "master"
        assert captured_auth_type[0] == "digest"
