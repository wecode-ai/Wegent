# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Unit tests for auth_utils module.

Tests API Key and JWT Token verification functions used for
executor authentication.
"""

import hashlib
from datetime import datetime, timedelta
from typing import Tuple

import pytest
from sqlalchemy.orm import Session

from app.core.auth_utils import (
    API_KEY_PREFIX,
    is_api_key,
    verify_api_key,
    verify_jwt_token_with_db,
    verify_token_flexible,
)
from app.core.security import create_access_token
from app.models.api_key import KEY_TYPE_PERSONAL, KEY_TYPE_SERVICE, APIKey
from app.models.user import User


@pytest.mark.unit
class TestIsApiKey:
    """Test is_api_key detection function"""

    def test_api_key_with_wg_prefix(self):
        """Test that tokens starting with 'wg-' are detected as API keys"""
        assert is_api_key("wg-abc123") is True
        assert is_api_key("wg-test-api-key-12345") is True
        assert is_api_key("wg-") is True

    def test_jwt_token_not_detected_as_api_key(self):
        """Test that JWT tokens are not detected as API keys"""
        jwt_token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0In0.test"
        assert is_api_key(jwt_token) is False

    def test_empty_token_not_detected_as_api_key(self):
        """Test that empty tokens are not detected as API keys"""
        assert is_api_key("") is False
        assert is_api_key(None) is False

    def test_token_with_wg_in_middle_not_detected(self):
        """Test that tokens with 'wg-' in middle are not detected"""
        assert is_api_key("somewg-token") is False
        assert is_api_key("test-wg-token") is False


@pytest.mark.unit
class TestVerifyApiKey:
    """Test verify_api_key function"""

    def test_verify_valid_api_key(
        self, test_db: Session, test_api_key: Tuple[str, APIKey], test_user: User
    ):
        """Test verifying a valid API key returns the user"""
        raw_key, api_key_record = test_api_key

        user = verify_api_key(test_db, raw_key)

        assert user is not None
        assert user.id == test_user.id
        assert user.user_name == test_user.user_name

    def test_verify_invalid_api_key(self, test_db: Session):
        """Test verifying an invalid API key returns None"""
        user = verify_api_key(test_db, "wg-invalid-key-12345")

        assert user is None

    def test_verify_non_api_key_format(self, test_db: Session):
        """Test verifying a non-API key format returns None"""
        user = verify_api_key(test_db, "not-an-api-key")

        assert user is None

    def test_verify_empty_api_key(self, test_db: Session):
        """Test verifying an empty API key returns None"""
        assert verify_api_key(test_db, "") is None
        assert verify_api_key(test_db, None) is None

    def test_verify_expired_api_key(self, test_db: Session, test_user: User):
        """Test verifying an expired API key returns None"""
        # Create an expired API key
        raw_key = "wg-expired-key-12345"
        key_hash = hashlib.sha256(raw_key.encode()).hexdigest()
        expired_key = APIKey(
            user_id=test_user.id,
            key_hash=key_hash,
            key_prefix="wg-expired...",
            name="Expired API Key",
            key_type=KEY_TYPE_PERSONAL,
            description="Expired API key for testing",
            expires_at=datetime.utcnow() - timedelta(days=1),  # Expired yesterday
            is_active=True,
        )
        test_db.add(expired_key)
        test_db.commit()

        user = verify_api_key(test_db, raw_key)

        assert user is None

    def test_verify_inactive_api_key(self, test_db: Session, test_user: User):
        """Test verifying an inactive API key returns None"""
        # Create an inactive API key
        raw_key = "wg-inactive-key-12345"
        key_hash = hashlib.sha256(raw_key.encode()).hexdigest()
        inactive_key = APIKey(
            user_id=test_user.id,
            key_hash=key_hash,
            key_prefix="wg-inactive...",
            name="Inactive API Key",
            key_type=KEY_TYPE_PERSONAL,
            description="Inactive API key for testing",
            expires_at=datetime.utcnow() + timedelta(days=365),
            is_active=False,  # Deactivated
        )
        test_db.add(inactive_key)
        test_db.commit()

        user = verify_api_key(test_db, raw_key)

        assert user is None

    def test_verify_service_key_rejected(self, test_db: Session, test_user: User):
        """Test verifying a service key is rejected (only personal keys allowed)"""
        # Create a service API key
        raw_key = "wg-service-key-12345"
        key_hash = hashlib.sha256(raw_key.encode()).hexdigest()
        service_key = APIKey(
            user_id=test_user.id,
            key_hash=key_hash,
            key_prefix="wg-service...",
            name="Service API Key",
            key_type=KEY_TYPE_SERVICE,  # Service key type
            description="Service API key for testing",
            expires_at=datetime.utcnow() + timedelta(days=365),
            is_active=True,
        )
        test_db.add(service_key)
        test_db.commit()

        user = verify_api_key(test_db, raw_key)

        assert user is None

    def test_verify_api_key_with_inactive_user(
        self, test_db: Session, test_inactive_user: User
    ):
        """Test verifying API key for inactive user returns None"""
        # Create API key for inactive user
        raw_key = "wg-inactive-user-key-12345"
        key_hash = hashlib.sha256(raw_key.encode()).hexdigest()
        api_key = APIKey(
            user_id=test_inactive_user.id,
            key_hash=key_hash,
            key_prefix="wg-inactive...",
            name="Inactive User API Key",
            key_type=KEY_TYPE_PERSONAL,
            description="API key for inactive user",
            expires_at=datetime.utcnow() + timedelta(days=365),
            is_active=True,
        )
        test_db.add(api_key)
        test_db.commit()

        user = verify_api_key(test_db, raw_key)

        assert user is None

    def test_verify_api_key_updates_last_used(
        self, test_db: Session, test_api_key: Tuple[str, APIKey], test_user: User
    ):
        """Test that verifying API key updates last_used_at timestamp"""
        raw_key, api_key_record = test_api_key

        # Record the original last_used_at
        original_last_used = api_key_record.last_used_at

        # Verify the API key
        user = verify_api_key(test_db, raw_key)

        # Refresh the record to get updated timestamp
        test_db.refresh(api_key_record)

        assert user is not None
        # last_used_at should be updated (or at least not before original)
        assert api_key_record.last_used_at >= original_last_used


@pytest.mark.unit
class TestVerifyJwtTokenWithDb:
    """Test verify_jwt_token_with_db function"""

    def test_verify_valid_jwt_token(
        self, test_db: Session, test_user: User, test_token: str
    ):
        """Test verifying a valid JWT token returns the user"""
        user = verify_jwt_token_with_db(test_db, test_token)

        assert user is not None
        assert user.id == test_user.id
        assert user.user_name == test_user.user_name

    def test_verify_invalid_jwt_token(self, test_db: Session):
        """Test verifying an invalid JWT token returns None"""
        user = verify_jwt_token_with_db(test_db, "invalid.token.here")

        assert user is None

    def test_verify_empty_jwt_token(self, test_db: Session):
        """Test verifying an empty JWT token returns None"""
        assert verify_jwt_token_with_db(test_db, "") is None

    def test_verify_jwt_token_nonexistent_user(self, test_db: Session):
        """Test verifying JWT token for nonexistent user returns None"""
        token = create_access_token({"sub": "nonexistent_user"})

        user = verify_jwt_token_with_db(test_db, token)

        assert user is None

    def test_verify_jwt_token_inactive_user(
        self, test_db: Session, test_inactive_user: User
    ):
        """Test verifying JWT token for inactive user returns None"""
        token = create_access_token({"sub": test_inactive_user.user_name})

        user = verify_jwt_token_with_db(test_db, token)

        assert user is None


@pytest.mark.unit
class TestVerifyTokenFlexible:
    """Test verify_token_flexible function"""

    def test_verify_api_key_flexible(
        self, test_db: Session, test_api_key: Tuple[str, APIKey], test_user: User
    ):
        """Test flexible verification with API key"""
        raw_key, api_key_record = test_api_key

        user, auth_type = verify_token_flexible(test_db, raw_key)

        assert user is not None
        assert user.id == test_user.id
        assert auth_type == "api_key"

    def test_verify_jwt_token_flexible(
        self, test_db: Session, test_user: User, test_token: str
    ):
        """Test flexible verification with JWT token"""
        user, auth_type = verify_token_flexible(test_db, test_token)

        assert user is not None
        assert user.id == test_user.id
        assert auth_type == "jwt"

    def test_verify_invalid_token_flexible(self, test_db: Session):
        """Test flexible verification with invalid token"""
        user, auth_type = verify_token_flexible(test_db, "invalid-token")

        assert user is None
        assert auth_type == ""

    def test_verify_invalid_api_key_flexible(self, test_db: Session):
        """Test flexible verification with invalid API key"""
        user, auth_type = verify_token_flexible(test_db, "wg-invalid-key")

        assert user is None
        assert auth_type == ""

    def test_verify_empty_token_flexible(self, test_db: Session):
        """Test flexible verification with empty token"""
        user, auth_type = verify_token_flexible(test_db, "")

        assert user is None
        assert auth_type == ""

    def test_verify_none_token_flexible(self, test_db: Session):
        """Test flexible verification with None token"""
        user, auth_type = verify_token_flexible(test_db, None)

        assert user is None
        assert auth_type == ""

    def test_verify_whitespace_token_flexible(self, test_db: Session):
        """Test flexible verification with whitespace token"""
        user, auth_type = verify_token_flexible(test_db, "   ")

        assert user is None
        assert auth_type == ""

    def test_verify_token_with_whitespace_padding(
        self, test_db: Session, test_api_key: Tuple[str, APIKey], test_user: User
    ):
        """Test flexible verification strips whitespace from token"""
        raw_key, api_key_record = test_api_key

        # Add whitespace padding
        padded_key = f"  {raw_key}  "

        user, auth_type = verify_token_flexible(test_db, padded_key)

        assert user is not None
        assert user.id == test_user.id
        assert auth_type == "api_key"
