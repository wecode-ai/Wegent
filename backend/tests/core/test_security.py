# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime, timedelta

import pytest
from fastapi import HTTPException
from jose import jwt
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.security import (
    authenticate_user,
    create_access_token,
    get_admin_user,
    get_current_user,
    get_password_hash,
    verify_password,
    verify_token,
)
from app.models.user import User


@pytest.mark.unit
class TestPasswordHashing:
    """Test password hashing and verification functions"""

    def test_get_password_hash_creates_valid_hash(self):
        """Test that get_password_hash creates a valid bcrypt hash"""
        password = "testpassword123"
        hashed = get_password_hash(password)

        assert hashed is not None
        assert hashed != password
        assert hashed.startswith("$2b$")  # bcrypt hash prefix

    def test_verify_password_with_correct_password(self):
        """Test password verification with correct password"""
        password = "testpassword123"
        hashed = get_password_hash(password)

        assert verify_password(password, hashed) is True

    def test_verify_password_with_incorrect_password(self):
        """Test password verification with incorrect password"""
        password = "testpassword123"
        hashed = get_password_hash(password)

        assert verify_password("wrongpassword", hashed) is False

    def test_verify_password_with_empty_password(self):
        """Test password verification with empty password"""
        hashed = get_password_hash("testpassword")

        assert verify_password("", hashed) is False

    def test_different_passwords_produce_different_hashes(self):
        """Test that different passwords produce different hashes"""
        hash1 = get_password_hash("password1")
        hash2 = get_password_hash("password2")

        assert hash1 != hash2

    def test_same_password_produces_different_hashes(self):
        """Test that same password produces different hashes (due to salt)"""
        password = "testpassword123"
        hash1 = get_password_hash(password)
        hash2 = get_password_hash(password)

        assert hash1 != hash2
        assert verify_password(password, hash1) is True
        assert verify_password(password, hash2) is True


@pytest.mark.unit
class TestTokenOperations:
    """Test JWT token creation and verification"""

    def test_create_access_token_with_default_expiration(self):
        """Test creating access token with default expiration"""
        data = {"sub": "testuser"}
        token = create_access_token(data)

        assert token is not None
        assert isinstance(token, str)

        # Verify token can be decoded
        payload = jwt.decode(
            token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM]
        )
        assert payload["sub"] == "testuser"
        assert "exp" in payload

    def test_create_access_token_with_custom_expiration(self):
        """Test creating access token with custom expiration"""
        import time

        data = {"sub": "testuser"}
        expires_delta = 60  # 60 minutes

        # Get current time as Unix timestamp
        before_timestamp = time.time()
        token = create_access_token(data, expires_delta=expires_delta)
        after_timestamp = time.time()

        payload = jwt.decode(
            token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM]
        )

        # Verify that the token contains the expected data
        assert payload["sub"] == "testuser"

        # Verify that exp field exists
        assert "exp" in payload

        # The exp field should be approximately 60 minutes from now
        # Calculate expected expiration range
        expected_exp_min = before_timestamp + (expires_delta * 60)
        expected_exp_max = after_timestamp + (expires_delta * 60)

        exp_timestamp = payload["exp"]

        # Verify expiration is within expected range (with 1 second tolerance)
        assert expected_exp_min - 1 <= exp_timestamp <= expected_exp_max + 1

    def test_create_access_token_with_additional_data(self):
        """Test creating access token with additional data"""
        data = {"sub": "testuser", "role": "admin", "email": "test@example.com"}
        token = create_access_token(data)

        payload = jwt.decode(
            token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM]
        )
        assert payload["sub"] == "testuser"
        assert payload["role"] == "admin"
        assert payload["email"] == "test@example.com"

    def test_verify_token_with_valid_token(self):
        """Test verifying a valid token"""
        data = {"sub": "testuser"}
        token = create_access_token(data)

        result = verify_token(token)
        assert result["username"] == "testuser"

    def test_verify_token_with_invalid_token(self):
        """Test verifying an invalid token raises HTTPException"""
        with pytest.raises(HTTPException) as exc_info:
            verify_token("invalid.token.here")

        assert exc_info.value.status_code == 401
        assert "Could not validate credentials" in exc_info.value.detail

    def test_verify_token_with_expired_token(self):
        """Test verifying an expired token raises HTTPException"""
        data = {"sub": "testuser"}
        # Create a token with very short expiration and wait for it to expire
        # Since create_access_token doesn't support negative values properly,
        # we'll create a token manually with past expiration
        import time
        from datetime import datetime, timedelta

        from jose import jwt

        expired_data = data.copy()
        # Use timestamp for expiration (1 minute ago)
        expired_data["exp"] = (datetime.now() - timedelta(minutes=1)).timestamp()
        expired_token = jwt.encode(
            expired_data, settings.SECRET_KEY, algorithm=settings.ALGORITHM
        )

        # jwt.decode will raise JWTError for expired tokens, which verify_token catches
        with pytest.raises(HTTPException) as exc_info:
            verify_token(expired_token)

        assert exc_info.value.status_code == 401

    def test_verify_token_without_username(self):
        """Test verifying token without username raises HTTPException"""
        # Create token without 'sub' field
        data = {"role": "admin"}
        token = jwt.encode(data, settings.SECRET_KEY, algorithm=settings.ALGORITHM)

        with pytest.raises(HTTPException) as exc_info:
            verify_token(token)

        assert exc_info.value.status_code == 401


@pytest.mark.unit
class TestAuthenticateUser:
    """Test user authentication function"""

    def test_authenticate_user_with_valid_credentials(
        self, test_db: Session, test_user: User
    ):
        """Test authenticating user with valid credentials"""
        user = authenticate_user(test_db, "testuser", "testpassword123")

        assert user is not None
        assert user.user_name == "testuser"
        assert user.email == "test@example.com"

    def test_authenticate_user_with_invalid_password(
        self, test_db: Session, test_user: User
    ):
        """Test authenticating user with invalid password"""
        user = authenticate_user(test_db, "testuser", "wrongpassword")

        assert user is None

    def test_authenticate_user_with_nonexistent_username(self, test_db: Session):
        """Test authenticating with nonexistent username"""
        user = authenticate_user(test_db, "nonexistent", "password123")

        assert user is None

    def test_authenticate_user_with_empty_username(self, test_db: Session):
        """Test authenticating with empty username"""
        user = authenticate_user(test_db, "", "password123")

        assert user is None

    def test_authenticate_user_with_empty_password(
        self, test_db: Session, test_user: User
    ):
        """Test authenticating with empty password"""
        user = authenticate_user(test_db, "testuser", "")

        assert user is None

    def test_authenticate_user_with_none_credentials(self, test_db: Session):
        """Test authenticating with None credentials"""
        user = authenticate_user(test_db, None, None)

        assert user is None

    def test_authenticate_inactive_user_raises_exception(
        self, test_db: Session, test_inactive_user: User
    ):
        """Test authenticating inactive user raises HTTPException"""
        with pytest.raises(HTTPException) as exc_info:
            authenticate_user(test_db, "inactiveuser", "inactive123")

        assert exc_info.value.status_code == 400
        assert "User not activated" in exc_info.value.detail


@pytest.mark.unit
class TestGetCurrentUser:
    """Test get_current_user dependency function"""

    def test_get_current_user_with_valid_token(
        self, test_db: Session, test_user: User, test_token: str, mocker
    ):
        """Test getting current user with valid token"""
        # Mock the oauth2_scheme dependency to return the token
        mock_oauth2 = mocker.patch("app.core.security.oauth2_scheme")
        mock_oauth2.return_value = test_token

        # Mock decrypt_user_git_info to handle None git_info
        mocker.patch(
            "app.services.user.UserService.decrypt_user_git_info",
            side_effect=lambda user: user,
        )

        user = get_current_user(token=test_token, db=test_db)

        assert user is not None
        assert user.user_name == "testuser"
        assert user.is_active is True

    def test_get_current_user_with_invalid_token(self, test_db: Session, mocker):
        """Test getting current user with invalid token raises HTTPException"""
        with pytest.raises(HTTPException) as exc_info:
            get_current_user(token="invalid.token", db=test_db)

        assert exc_info.value.status_code == 401

    def test_get_current_user_with_nonexistent_user(self, test_db: Session, mocker):
        """Test getting current user when user doesn't exist in database"""
        # Create token for non-existent user
        token = create_access_token({"sub": "nonexistent"})

        with pytest.raises(HTTPException) as exc_info:
            get_current_user(token=token, db=test_db)

        # user_service.get_user_by_name raises 404 when user not found
        assert exc_info.value.status_code == 404
        assert "not found" in exc_info.value.detail

    def test_get_current_user_with_inactive_user(
        self, test_db: Session, test_inactive_user: User, mocker
    ):
        """Test getting current user when user is inactive"""
        token = create_access_token({"sub": "inactiveuser"})

        # Mock decrypt_user_git_info to handle None git_info
        mocker.patch(
            "app.services.user.UserService.decrypt_user_git_info",
            side_effect=lambda user: user,
        )

        with pytest.raises(HTTPException) as exc_info:
            get_current_user(token=token, db=test_db)

        assert exc_info.value.status_code == 401
        assert "User not activated" in exc_info.value.detail


@pytest.mark.unit
class TestGetAdminUser:
    """Test get_admin_user function"""

    def test_get_admin_user_with_admin(self, test_admin_user: User):
        """Test getting admin user with admin account"""
        admin = get_admin_user(current_user=test_admin_user)

        assert admin is not None
        assert admin.user_name == "admin"

    def test_get_admin_user_with_regular_user(self, test_user: User):
        """Test getting admin user with regular user raises HTTPException"""
        with pytest.raises(HTTPException) as exc_info:
            get_admin_user(current_user=test_user)

        assert exc_info.value.status_code == 403
        assert "Permission denied" in exc_info.value.detail
