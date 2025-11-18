# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Tests for app/services/user.py
"""

import pytest
from unittest.mock import Mock, patch, MagicMock
from fastapi import HTTPException

from app.services.user import UserService, user_service
from app.models.user import User
from app.schemas.user import UserCreate, UserUpdate, GitInfo
from app.core.exceptions import ValidationException
from shared.utils.crypto import encrypt_git_token


class TestUserServiceValidateGitInfo:
    """Test _validate_git_info method"""

    def test_validate_git_info_with_valid_github_token(self, test_db):
        """Test validating GitHub token successfully"""
        git_info = [
            {
                "type": "github",
                "git_domain": "github.com",
                "git_token": "ghp_test_token_123"
            }
        ]

        # Mock GitHub provider validation
        with patch('app.services.user.GitHubProvider') as mock_github:
            mock_provider = Mock()
            mock_provider.validate_token.return_value = {
                "valid": True,
                "user": {
                    "id": 12345,
                    "login": "testuser",
                    "email": "test@github.com"
                }
            }
            mock_github.return_value = mock_provider

            result = user_service._validate_git_info(git_info)

            assert len(result) == 1
            assert result[0]["git_id"] == "12345"
            assert result[0]["git_login"] == "testuser"
            assert result[0]["git_email"] == "test@github.com"
            # Token should be encrypted
            assert result[0]["git_token"] != "ghp_test_token_123"

    def test_validate_git_info_with_invalid_token(self, test_db):
        """Test validating invalid GitHub token raises exception"""
        git_info = [
            {
                "type": "github",
                "git_domain": "github.com",
                "git_token": "invalid_token"
            }
        ]

        with patch('app.services.user.GitHubProvider') as mock_github:
            mock_provider = Mock()
            mock_provider.validate_token.return_value = {"valid": False}
            mock_github.return_value = mock_provider

            with pytest.raises(ValidationException) as exc_info:
                user_service._validate_git_info(git_info)

            assert "Invalid github token" in str(exc_info.value.detail)

    def test_validate_git_info_missing_git_token(self):
        """Test validation fails when git_token is missing"""
        git_info = [
            {
                "type": "github",
                "git_domain": "github.com"
            }
        ]

        with pytest.raises(ValidationException) as exc_info:
            user_service._validate_git_info(git_info)

        assert "git_token is required" in str(exc_info.value.detail)

    def test_validate_git_info_missing_git_domain(self):
        """Test validation fails when git_domain is missing"""
        git_info = [
            {
                "type": "github",
                "git_token": "ghp_test_token"
            }
        ]

        with pytest.raises(ValidationException) as exc_info:
            user_service._validate_git_info(git_info)

        assert "git_domain is required" in str(exc_info.value.detail)

    def test_validate_git_info_missing_type(self):
        """Test validation fails when type is missing"""
        git_info = [
            {
                "git_domain": "github.com",
                "git_token": "ghp_test_token"
            }
        ]

        with pytest.raises(ValidationException) as exc_info:
            user_service._validate_git_info(git_info)

        assert "type is required" in str(exc_info.value.detail)

    def test_validate_git_info_unsupported_provider(self):
        """Test validation fails with unsupported provider type"""
        git_info = [
            {
                "type": "unsupported",
                "git_domain": "example.com",
                "git_token": "test_token"
            }
        ]

        with pytest.raises(ValidationException) as exc_info:
            user_service._validate_git_info(git_info)

        assert "Unsupported provider type" in str(exc_info.value.detail)

    def test_validate_git_info_with_gitlab(self):
        """Test validating GitLab token"""
        git_info = [
            {
                "type": "gitlab",
                "git_domain": "gitlab.com",
                "git_token": "glpat_test_token"
            }
        ]

        with patch('app.services.user.GitLabProvider') as mock_gitlab:
            mock_provider = Mock()
            mock_provider.validate_token.return_value = {
                "valid": True,
                "user": {
                    "id": 67890,
                    "login": "gitlabuser",
                    "email": "test@gitlab.com"
                }
            }
            mock_gitlab.return_value = mock_provider

            result = user_service._validate_git_info(git_info)

            assert result[0]["git_id"] == "67890"
            assert result[0]["git_login"] == "gitlabuser"

    def test_validate_git_info_already_encrypted_token(self):
        """Test that already encrypted token is not re-encrypted"""
        encrypted_token = encrypt_git_token("original_token")
        git_info = [
            {
                "type": "github",
                "git_domain": "github.com",
                "git_token": encrypted_token
            }
        ]

        with patch('app.services.user.GitHubProvider') as mock_github:
            mock_provider = Mock()
            mock_provider.validate_token.return_value = {
                "valid": True,
                "user": {
                    "id": 12345,
                    "login": "testuser",
                    "email": "test@github.com"
                }
            }
            mock_github.return_value = mock_provider

            result = user_service._validate_git_info(git_info)

            # Token should remain the same (already encrypted)
            assert result[0]["git_token"] == encrypted_token


class TestUserServiceCreateUser:
    """Test create_user method"""

    def test_create_user_with_valid_data(self, test_db):
        """Test creating user with valid data"""
        user_data = UserCreate(
            user_name="newuser",
            email="new@example.com",
            password="newpassword123",
            git_info=[]
        )

        user = user_service.create_user(test_db, obj_in=user_data)

        assert user.user_name == "newuser"
        assert user.email == "new@example.com"
        assert user.is_active is True
        assert user.password_hash is not None

    def test_create_user_with_git_info(self, test_db):
        """Test creating user with Git configuration"""
        git_info_obj = GitInfo(
            type="github",
            git_domain="github.com",
            git_token="ghp_test_token"
        )

        user_data = UserCreate(
            user_name="gituser",
            password="gitpassword123",
            git_info=[git_info_obj]
        )

        with patch('app.services.user.GitHubProvider') as mock_github:
            mock_provider = Mock()
            mock_provider.validate_token.return_value = {
                "valid": True,
                "user": {
                    "id": 12345,
                    "login": "gituser",
                    "email": "git@example.com"
                }
            }
            mock_github.return_value = mock_provider

            user = user_service.create_user(test_db, obj_in=user_data)

            assert user.user_name == "gituser"
            assert len(user.git_info) == 1
            assert user.git_info[0]["git_login"] == "gituser"
            # Email should be populated from git info
            assert user.email == "git@example.com"

    def test_create_user_duplicate_username(self, test_db, test_user):
        """Test creating user with duplicate username raises exception"""
        user_data = UserCreate(
            user_name="testuser",  # Already exists
            email="another@example.com",
            password="anotherpassword123"
        )

        with pytest.raises(HTTPException) as exc_info:
            user_service.create_user(test_db, obj_in=user_data)

        assert exc_info.value.status_code == 400
        assert "already exists" in str(exc_info.value.detail)

    def test_create_user_default_password_from_username(self, test_db):
        """Test password defaults to username if not provided"""
        user_data = UserCreate(
            user_name="defaultuser",
            email="default@example.com"
        )

        with patch('app.core.security.get_password_hash') as mock_hash:
            mock_hash.return_value = "hashed_password"

            user_service.create_user(test_db, obj_in=user_data)

            # Should hash the username as password
            mock_hash.assert_called_once_with("defaultuser")


class TestUserServiceUpdateCurrentUser:
    """Test update_current_user method"""

    def test_update_user_email(self, test_db, test_user):
        """Test updating user email"""
        update_data = UserUpdate(email="updated@example.com")

        updated_user = user_service.update_current_user(
            test_db,
            user=test_user,
            obj_in=update_data
        )

        assert updated_user.email == "updated@example.com"
        assert updated_user.user_name == test_user.user_name

    def test_update_user_password(self, test_db, test_user):
        """Test updating user password"""
        update_data = UserUpdate(password="newpassword123")

        updated_user = user_service.update_current_user(
            test_db,
            user=test_user,
            obj_in=update_data
        )

        # Password should be updated
        assert updated_user.password_hash != test_user.password_hash

    def test_update_user_git_info(self, test_db, test_user):
        """Test updating user Git info"""
        git_info_obj = GitInfo(
            type="github",
            git_domain="github.com",
            git_token="new_token"
        )
        update_data = UserUpdate(git_info=[git_info_obj])

        with patch('app.services.user.GitHubProvider') as mock_github:
            mock_provider = Mock()
            mock_provider.validate_token.return_value = {
                "valid": True,
                "user": {
                    "id": 99999,
                    "login": "updateduser",
                    "email": "updated@github.com"
                }
            }
            mock_github.return_value = mock_provider

            updated_user = user_service.update_current_user(
                test_db,
                user=test_user,
                obj_in=update_data
            )

            assert len(updated_user.git_info) == 1
            assert updated_user.git_info[0]["git_login"] == "updateduser"

    def test_update_user_duplicate_username(self, test_db, test_user):
        """Test updating to duplicate username raises exception"""
        # Create another user
        other_user = User(
            user_name="otheruser",
            email="other@example.com",
            password_hash="hashed",
            is_active=True
        )
        test_db.add(other_user)
        test_db.commit()

        update_data = UserUpdate(user_name="otheruser")

        with pytest.raises(HTTPException) as exc_info:
            user_service.update_current_user(
                test_db,
                user=test_user,
                obj_in=update_data
            )

        assert exc_info.value.status_code == 400
        assert "already exists" in str(exc_info.value.detail)

    def test_update_user_without_validation(self, test_db, test_user):
        """Test updating Git info without validation"""
        git_info_obj = GitInfo(
            type="github",
            git_domain="github.com",
            git_token="unvalidated_token"
        )
        update_data = UserUpdate(git_info=[git_info_obj])

        # Update without validation
        updated_user = user_service.update_current_user(
            test_db,
            user=test_user,
            obj_in=update_data,
            validate_git_info=False
        )

        # Git info should be updated without validation
        assert len(updated_user.git_info) == 1
        assert updated_user.git_info[0]["git_token"] == "unvalidated_token"


class TestUserServiceGetUserMethods:
    """Test get user methods"""

    def test_get_user_by_id_exists(self, test_db, test_user):
        """Test getting user by ID when user exists"""
        user = user_service.get_user_by_id(test_db, user_id=test_user.id)

        assert user.id == test_user.id
        assert user.user_name == test_user.user_name

    def test_get_user_by_id_not_exists(self, test_db):
        """Test getting user by ID when user doesn't exist"""
        with pytest.raises(HTTPException) as exc_info:
            user_service.get_user_by_id(test_db, user_id=99999)

        assert exc_info.value.status_code == 404
        assert "not found" in str(exc_info.value.detail).lower()

    def test_get_user_by_name_exists(self, test_db, test_user):
        """Test getting user by name when user exists"""
        user = user_service.get_user_by_name(test_db, user_name="testuser")

        assert user.user_name == "testuser"

    def test_get_user_by_name_not_exists(self, test_db):
        """Test getting user by name when user doesn't exist"""
        with pytest.raises(HTTPException) as exc_info:
            user_service.get_user_by_name(test_db, user_name="nonexistent")

        assert exc_info.value.status_code == 404
        assert "not found" in str(exc_info.value.detail).lower()

    def test_get_all_users(self, test_db, test_user, inactive_user):
        """Test getting all active users"""
        users = user_service.get_all_users(test_db)

        # Should only return active users
        usernames = [u.user_name for u in users]
        assert "testuser" in usernames
        assert "inactiveuser" not in usernames

    def test_get_all_users_empty(self, test_db):
        """Test getting all users when none exist"""
        users = user_service.get_all_users(test_db)

        assert users == []
