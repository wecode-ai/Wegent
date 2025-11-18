# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Tests for app/core/security.py
"""

import pytest
from datetime import datetime, timedelta
from jose import jwt, JWTError
from fastapi import HTTPException

from app.core import security
from app.core.config import settings
from app.models.user import User


class TestPasswordHashing:
    """Test password hashing and verification"""

    def test_get_password_hash_creates_valid_hash(self):
        """Test that password hashing creates a valid bcrypt hash"""
        plain_password = "testpassword123"
        hashed = security.get_password_hash(plain_password)

        assert hashed is not None
        assert hashed != plain_password
        assert hashed.startswith("$2b$")  # bcrypt hash format

    def test_verify_password_with_correct_password(self):
        """Test password verification with correct password"""
        plain_password = "testpassword123"
        hashed = security.get_password_hash(plain_password)

        assert security.verify_password(plain_password, hashed) is True

    def test_verify_password_with_wrong_password(self):
        """Test password verification with incorrect password"""
        plain_password = "testpassword123"
        hashed = security.get_password_hash(plain_password)

        assert security.verify_password("wrongpassword", hashed) is False

    def test_verify_password_with_empty_password(self):
        """Test password verification with empty password"""
        plain_password = "testpassword123"
        hashed = security.get_password_hash(plain_password)

        assert security.verify_password("", hashed) is False

    def test_different_passwords_produce_different_hashes(self):
        """Test that different passwords produce different hashes"""
        hash1 = security.get_password_hash("password1")
        hash2 = security.get_password_hash("password2")

        assert hash1 != hash2


class TestJWTToken:
    """Test JWT token creation and verification"""

    def test_create_access_token_with_default_expiration(self):
        """Test creating access token with default expiration"""
        data = {"sub": "testuser", "username": "testuser"}
        token = security.create_access_token(data)

        assert token is not None
        assert isinstance(token, str)

        # Verify token can be decoded
        payload = jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
        assert payload["sub"] == "testuser"
        assert payload["username"] == "testuser"
        assert "exp" in payload

    def test_create_access_token_with_custom_expiration(self):
        """Test creating access token with custom expiration"""
        data = {"sub": "testuser"}
        expires_delta = 30  # 30 minutes
        token = security.create_access_token(data, expires_delta=expires_delta)

        payload = jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
        exp_timestamp = payload["exp"]
        expected_exp = datetime.now() + timedelta(minutes=expires_delta)

        # Allow 5 seconds tolerance
        assert abs((datetime.fromtimestamp(exp_timestamp) - expected_exp).total_seconds()) < 5

    def test_verify_token_with_valid_token(self):
        """Test verifying a valid token"""
        data = {"sub": "testuser", "username": "testuser"}
        token = security.create_access_token(data)

        result = security.verify_token(token)
        assert result["username"] == "testuser"

    def test_verify_token_with_invalid_token(self):
        """Test verifying an invalid token raises HTTPException"""
        invalid_token = "invalid.token.here"

        with pytest.raises(HTTPException) as exc_info:
            security.verify_token(invalid_token)

        assert exc_info.value.status_code == 401
        assert "Could not validate credentials" in exc_info.value.detail

    def test_verify_token_with_expired_token(self):
        """Test verifying an expired token raises HTTPException"""
        data = {"sub": "testuser", "username": "testuser"}
        # Create token that expires immediately
        past_time = datetime.now() - timedelta(minutes=1)
        data["exp"] = past_time

        token = jwt.encode(data, settings.SECRET_KEY, algorithm=settings.ALGORITHM)

        with pytest.raises(HTTPException) as exc_info:
            security.verify_token(token)

        assert exc_info.value.status_code == 401

    def test_verify_token_without_username(self):
        """Test verifying token without username field"""
        data = {"sub": None}
        token = security.create_access_token(data)

        with pytest.raises(HTTPException) as exc_info:
            security.verify_token(token)

        assert exc_info.value.status_code == 401


class TestAuthenticateUser:
    """Test user authentication"""

    def test_authenticate_user_with_valid_credentials(self, test_db, test_user):
        """Test authenticating user with valid credentials"""
        user = security.authenticate_user(
            test_db,
            username="testuser",
            password="testpassword123"
        )

        assert user is not None
        assert user.user_name == "testuser"

    def test_authenticate_user_with_wrong_password(self, test_db, test_user):
        """Test authenticating user with wrong password"""
        user = security.authenticate_user(
            test_db,
            username="testuser",
            password="wrongpassword"
        )

        assert user is None

    def test_authenticate_user_with_wrong_username(self, test_db, test_user):
        """Test authenticating user with non-existent username"""
        user = security.authenticate_user(
            test_db,
            username="nonexistent",
            password="testpassword123"
        )

        assert user is None

    def test_authenticate_user_with_empty_username(self, test_db):
        """Test authenticating with empty username"""
        user = security.authenticate_user(
            test_db,
            username="",
            password="testpassword123"
        )

        assert user is None

    def test_authenticate_user_with_empty_password(self, test_db, test_user):
        """Test authenticating with empty password"""
        user = security.authenticate_user(
            test_db,
            username="testuser",
            password=""
        )

        assert user is None

    def test_authenticate_inactive_user(self, test_db, inactive_user):
        """Test authenticating inactive user raises exception"""
        with pytest.raises(HTTPException) as exc_info:
            security.authenticate_user(
                test_db,
                username="inactiveuser",
                password="inactivepassword123"
            )

        assert exc_info.value.status_code == 400
        assert "not activated" in exc_info.value.detail.lower()


class TestGetCurrentUser:
    """Test getting current user from token"""

    def test_get_current_user_with_valid_token(self, test_db, test_user, test_token):
        """Test getting current user with valid token"""
        user = security.get_current_user(token=test_token, db=test_db)

        assert user is not None
        assert user.user_name == "testuser"
        assert user.is_active is True

    def test_get_current_user_with_invalid_token(self, test_db):
        """Test getting current user with invalid token"""
        with pytest.raises(HTTPException) as exc_info:
            security.get_current_user(token="invalid_token", db=test_db)

        assert exc_info.value.status_code == 401

    def test_get_current_user_with_nonexistent_user(self, test_db):
        """Test getting current user when user doesn't exist in database"""
        # Create token for non-existent user
        data = {"sub": "nonexistent", "username": "nonexistent"}
        token = security.create_access_token(data)

        with pytest.raises(HTTPException) as exc_info:
            security.get_current_user(token=token, db=test_db)

        assert exc_info.value.status_code == 401
        assert "Could not validate credentials" in exc_info.value.detail

    def test_get_current_user_inactive(self, test_db, inactive_user):
        """Test getting inactive user raises exception"""
        # Create token for inactive user
        data = {"sub": inactive_user.user_name, "username": inactive_user.user_name}
        token = security.create_access_token(data)

        with pytest.raises(HTTPException) as exc_info:
            security.get_current_user(token=token, db=test_db)

        assert exc_info.value.status_code == 401
        assert "not activated" in exc_info.value.detail.lower()


class TestGetUsernameFromRequest:
    """Test extracting username from request"""

    def test_get_username_from_request_with_valid_token(self, test_token):
        """Test extracting username from valid Authorization header"""
        from unittest.mock import Mock

        request = Mock()
        request.headers = {"Authorization": f"Bearer {test_token}"}

        username = security.get_username_from_request(request)
        assert username == "testuser"

    def test_get_username_from_request_without_auth_header(self):
        """Test extracting username without Authorization header"""
        from unittest.mock import Mock

        request = Mock()
        request.headers = {}

        username = security.get_username_from_request(request)
        assert username == "anonymous"

    def test_get_username_from_request_with_invalid_token(self):
        """Test extracting username with invalid token"""
        from unittest.mock import Mock

        request = Mock()
        request.headers = {"Authorization": "Bearer invalid_token"}

        username = security.get_username_from_request(request)
        assert username == "invalid_token"

    def test_get_username_from_request_with_malformed_header(self):
        """Test extracting username with malformed Authorization header"""
        from unittest.mock import Mock

        request = Mock()
        request.headers = {"Authorization": "InvalidFormat"}

        username = security.get_username_from_request(request)
        assert username == "anonymous"


class TestGetAdminUser:
    """Test admin user verification"""

    def test_get_admin_user_with_admin(self, test_db):
        """Test getting admin user when user is admin"""
        admin_user = User(
            user_name="admin",
            email="admin@example.com",
            password_hash=security.get_password_hash("admin123"),
            is_active=True
        )
        test_db.add(admin_user)
        test_db.commit()

        result = security.get_admin_user(current_user=admin_user)
        assert result.user_name == "admin"

    def test_get_admin_user_with_non_admin(self, test_user):
        """Test getting admin user when user is not admin"""
        with pytest.raises(HTTPException) as exc_info:
            security.get_admin_user(current_user=test_user)

        assert exc_info.value.status_code == 403
        assert "Permission denied" in exc_info.value.detail
