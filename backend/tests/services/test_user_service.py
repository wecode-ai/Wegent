# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.core.exceptions import ValidationException
from app.models.user import User
from app.services.user import UserService, user_service


@pytest.mark.unit
class TestUserServiceValidateGitInfo:
    """Test UserService._validate_git_info method"""

    def test_validate_git_info_with_missing_token(self):
        """Test validation fails when git_token is missing"""
        service = UserService(User)
        git_info = [{"git_domain": "github.com", "type": "github"}]

        with pytest.raises(ValidationException) as exc_info:
            service._validate_git_info(git_info)

        assert "git_token is required" in str(exc_info.value.detail)

    def test_validate_git_info_with_missing_domain(self):
        """Test validation fails when git_domain is missing"""
        service = UserService(User)
        git_info = [{"git_token": "test_token", "type": "github"}]

        with pytest.raises(ValidationException) as exc_info:
            service._validate_git_info(git_info)

        assert "git_domain is required" in str(exc_info.value.detail)

    def test_validate_git_info_with_missing_type(self):
        """Test validation fails when type is missing"""
        service = UserService(User)
        git_info = [{"git_token": "test_token", "git_domain": "github.com"}]

        with pytest.raises(ValidationException) as exc_info:
            service._validate_git_info(git_info)

        assert "type is required" in str(exc_info.value.detail)

    def test_validate_git_info_with_unsupported_provider(self):
        """Test validation fails with unsupported provider type"""
        service = UserService(User)
        git_info = [
            {
                "git_token": "test_token",
                "git_domain": "example.com",
                "type": "unsupported",
            }
        ]

        with pytest.raises(ValidationException) as exc_info:
            service._validate_git_info(git_info)

        assert "Unsupported provider type" in str(exc_info.value.detail)

    def test_validate_git_info_with_invalid_github_token(self, mocker):
        """Test validation fails with invalid GitHub token"""
        service = UserService(User)

        # Mock GitHubProvider.validate_token to return invalid result
        mock_validate = mocker.patch(
            "app.repository.github_provider.GitHubProvider.validate_token",
            return_value={"valid": False},
        )

        git_info = [
            {"git_token": "invalid_token", "git_domain": "github.com", "type": "github"}
        ]

        with pytest.raises(ValidationException) as exc_info:
            service._validate_git_info(git_info)

        assert "Invalid github token" in str(exc_info.value.detail)
        mock_validate.assert_called_once()

    def test_validate_git_info_with_valid_github_token(self, mocker):
        """Test successful validation with valid GitHub token"""
        service = UserService(User)

        # Mock GitHubProvider.validate_token to return valid result
        mock_validate = mocker.patch(
            "app.repository.github_provider.GitHubProvider.validate_token",
            return_value={
                "valid": True,
                "user": {"id": 12345, "login": "testuser", "email": "test@example.com"},
            },
        )

        # Mock encryption function
        mock_encrypt = mocker.patch(
            "app.services.user.encrypt_git_token", return_value="encrypted_token"
        )
        mock_is_encrypted = mocker.patch(
            "app.services.user.is_token_encrypted", return_value=False
        )

        git_info = [
            {"git_token": "valid_token", "git_domain": "github.com", "type": "github"}
        ]

        result = service._validate_git_info(git_info)

        assert len(result) == 1
        assert result[0]["git_id"] == "12345"
        assert result[0]["git_login"] == "testuser"
        assert result[0]["git_email"] == "test@example.com"
        assert result[0]["git_token"] == "encrypted_token"


@pytest.mark.unit
class TestUserServiceGetUser:
    """Test UserService get user methods"""

    def test_get_user_by_id_existing_user(
        self, test_db: Session, test_user: User, mocker
    ):
        """Test getting existing user by ID"""
        service = UserService(User)

        # Mock decrypt_user_git_info to handle None git_info
        mocker.patch.object(
            service, "decrypt_user_git_info", side_effect=lambda user: user
        )

        user = service.get_user_by_id(test_db, test_user.id)

        assert user is not None
        assert user.id == test_user.id
        assert user.user_name == test_user.user_name

    def test_get_user_by_id_nonexistent_user(self, test_db: Session):
        """Test getting nonexistent user by ID raises HTTPException"""
        service = UserService(User)

        with pytest.raises(HTTPException) as exc_info:
            service.get_user_by_id(test_db, 99999)

        assert exc_info.value.status_code == 404
        assert "not found" in exc_info.value.detail

    def test_get_user_by_name_existing_user(
        self, test_db: Session, test_user: User, mocker
    ):
        """Test getting existing user by username"""
        service = UserService(User)

        # Mock decrypt_user_git_info to handle None git_info
        mocker.patch.object(
            service, "decrypt_user_git_info", side_effect=lambda user: user
        )

        user = service.get_user_by_name(test_db, test_user.user_name)

        assert user is not None
        assert user.user_name == test_user.user_name
        assert user.email == test_user.email

    def test_get_user_by_name_nonexistent_user(self, test_db: Session):
        """Test getting nonexistent user by username raises HTTPException"""
        service = UserService(User)

        with pytest.raises(HTTPException) as exc_info:
            service.get_user_by_name(test_db, "nonexistent")

        assert exc_info.value.status_code == 404
        assert "not found" in exc_info.value.detail

    def test_get_all_users(
        self, test_db: Session, test_user: User, test_admin_user: User, mocker
    ):
        """Test getting all active users"""
        service = UserService(User)

        # Mock decrypt_user_git_info to handle None git_info
        mocker.patch.object(
            service, "decrypt_user_git_info", side_effect=lambda user: user
        )

        users = service.get_all_users(test_db)

        assert len(users) >= 2
        usernames = [u.user_name for u in users]
        assert test_user.user_name in usernames
        assert test_admin_user.user_name in usernames

    def test_get_all_users_excludes_inactive(
        self, test_db: Session, test_user: User, test_inactive_user: User, mocker
    ):
        """Test getting all users excludes inactive users"""
        service = UserService(User)

        # Mock decrypt_user_git_info to handle None git_info
        mocker.patch.object(
            service, "decrypt_user_git_info", side_effect=lambda user: user
        )

        users = service.get_all_users(test_db)

        usernames = [u.user_name for u in users]
        assert test_user.user_name in usernames
        assert test_inactive_user.user_name not in usernames


@pytest.mark.unit
class TestUserServiceGerritAuthType:
    """Test UserService._validate_git_info for Gerrit auth_type handling"""

    def test_validate_gerrit_with_digest_auth(self, mocker):
        """Test validation with Gerrit digest authentication"""
        service = UserService(User)

        # Mock GerritProvider.validate_token to return valid result
        mock_validate = mocker.patch(
            "app.repository.gerrit_provider.GerritProvider.validate_token",
            return_value={
                "valid": True,
                "user": {
                    "id": 12345,
                    "login": "gerrit_user",
                    "email": "gerrit@example.com",
                },
            },
        )

        # Mock encryption functions
        mocker.patch(
            "app.services.user.encrypt_git_token", return_value="encrypted_token"
        )
        mocker.patch("app.services.user.is_token_encrypted", return_value=False)

        git_info = [
            {
                "git_token": "valid_gerrit_token",
                "git_domain": "gerrit.example.com",
                "type": "gerrit",
                "user_name": "gerrit_user",
                "auth_type": "digest",
            }
        ]

        result = service._validate_git_info(git_info)

        assert len(result) == 1
        assert result[0]["git_id"] == "12345"
        assert result[0]["git_login"] == "gerrit_user"

        # Verify validate_token was called with auth_type parameter
        mock_validate.assert_called_once_with(
            "valid_gerrit_token",
            git_domain="gerrit.example.com",
            user_name="gerrit_user",
            auth_type="digest",
        )

    def test_validate_gerrit_with_basic_auth(self, mocker):
        """Test validation with Gerrit basic authentication"""
        service = UserService(User)

        # Mock GerritProvider.validate_token to return valid result
        mock_validate = mocker.patch(
            "app.repository.gerrit_provider.GerritProvider.validate_token",
            return_value={
                "valid": True,
                "user": {
                    "id": 67890,
                    "login": "basic_user",
                    "email": "basic@example.com",
                },
            },
        )

        # Mock encryption functions
        mocker.patch(
            "app.services.user.encrypt_git_token", return_value="encrypted_token"
        )
        mocker.patch("app.services.user.is_token_encrypted", return_value=False)

        git_info = [
            {
                "git_token": "valid_gerrit_token",
                "git_domain": "gerrit.example.com",
                "type": "gerrit",
                "user_name": "basic_user",
                "auth_type": "basic",
            }
        ]

        result = service._validate_git_info(git_info)

        assert len(result) == 1
        assert result[0]["git_id"] == "67890"

        # Verify validate_token was called with auth_type="basic"
        mock_validate.assert_called_once_with(
            "valid_gerrit_token",
            git_domain="gerrit.example.com",
            user_name="basic_user",
            auth_type="basic",
        )

    def test_validate_gerrit_defaults_to_digest_auth(self, mocker):
        """Test that Gerrit validation defaults to digest auth when auth_type is not specified"""
        service = UserService(User)

        # Mock GerritProvider.validate_token to return valid result
        mock_validate = mocker.patch(
            "app.repository.gerrit_provider.GerritProvider.validate_token",
            return_value={
                "valid": True,
                "user": {
                    "id": 11111,
                    "login": "default_user",
                    "email": "default@example.com",
                },
            },
        )

        # Mock encryption functions
        mocker.patch(
            "app.services.user.encrypt_git_token", return_value="encrypted_token"
        )
        mocker.patch("app.services.user.is_token_encrypted", return_value=False)

        git_info = [
            {
                "git_token": "valid_gerrit_token",
                "git_domain": "gerrit.example.com",
                "type": "gerrit",
                "user_name": "default_user",
                # No auth_type specified - should default to "digest"
            }
        ]

        result = service._validate_git_info(git_info)

        assert len(result) == 1

        # Verify validate_token was called with auth_type="digest" (default)
        mock_validate.assert_called_once_with(
            "valid_gerrit_token",
            git_domain="gerrit.example.com",
            user_name="default_user",
            auth_type="digest",
        )

    def test_validate_gerrit_raises_auth_error_message(self, mocker):
        """Test that validation raises error with auth method message from Gerrit"""
        service = UserService(User)

        # Mock GerritProvider.validate_token to return auth failure with message
        mock_validate = mocker.patch(
            "app.repository.gerrit_provider.GerritProvider.validate_token",
            return_value={
                "valid": False,
                "error": "auth_failed",
                "message": "Authentication failed. Please check if the auth method (basic) is correct.",
            },
        )

        git_info = [
            {
                "git_token": "invalid_token",
                "git_domain": "gerrit.example.com",
                "type": "gerrit",
                "user_name": "test_user",
                "auth_type": "basic",
            }
        ]

        with pytest.raises(ValidationException) as exc_info:
            service._validate_git_info(git_info)

        # Verify the error message contains the auth method hint
        assert "Authentication failed" in str(exc_info.value.detail)
        assert "basic" in str(exc_info.value.detail)

    def test_validate_gerrit_raises_generic_error_without_message(self, mocker):
        """Test that validation raises generic error when no message is provided"""
        service = UserService(User)

        # Mock GerritProvider.validate_token to return auth failure without message
        mock_validate = mocker.patch(
            "app.repository.gerrit_provider.GerritProvider.validate_token",
            return_value={"valid": False},
        )

        git_info = [
            {
                "git_token": "invalid_token",
                "git_domain": "gerrit.example.com",
                "type": "gerrit",
                "user_name": "test_user",
                "auth_type": "digest",
            }
        ]

        with pytest.raises(ValidationException) as exc_info:
            service._validate_git_info(git_info)

        # Verify the generic error message is raised
        assert "Invalid gerrit token" in str(exc_info.value.detail)

    def test_validate_gerrit_requires_username(self):
        """Test that Gerrit validation requires username"""
        service = UserService(User)

        git_info = [
            {
                "git_token": "valid_token",
                "git_domain": "gerrit.example.com",
                "type": "gerrit",
                "auth_type": "digest",
                # Missing user_name
            }
        ]

        with pytest.raises(ValidationException) as exc_info:
            service._validate_git_info(git_info)

        assert "username is required for Gerrit" in str(exc_info.value.detail)
