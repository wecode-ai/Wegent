# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for JWT token expiry functions."""

import time
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import pytest
from jose import jwt

from app.core.config import settings
from app.services.chat.access.auth import get_token_expiry, is_token_expired


def create_test_token(exp_delta_seconds: int) -> str:
    """Create a test JWT token with specified expiry delta from now."""
    # Use timezone-aware UTC datetime for consistency
    exp_time = datetime.now(timezone.utc) + timedelta(seconds=exp_delta_seconds)
    payload = {
        "sub": "testuser",
        "user_id": 1,
        "exp": exp_time,
    }
    return jwt.encode(payload, settings.SECRET_KEY, algorithm=settings.ALGORITHM)


class TestIsTokenExpired:
    """Tests for is_token_expired function."""

    def test_valid_token_not_expired(self):
        """Token with future expiry should return False."""
        token = create_test_token(exp_delta_seconds=3600)  # Expires in 1 hour
        assert is_token_expired(token) is False

    def test_expired_token(self):
        """Token with past expiry should return True."""
        token = create_test_token(exp_delta_seconds=-60)  # Expired 1 minute ago
        assert is_token_expired(token) is True

    def test_invalid_token_returns_true(self):
        """Invalid token should be treated as expired."""
        assert is_token_expired("invalid.token.here") is True

    def test_empty_token_returns_true(self):
        """Empty token should be treated as expired."""
        assert is_token_expired("") is True

    def test_token_about_to_expire(self):
        """Token expiring very soon should still be valid."""
        token = create_test_token(exp_delta_seconds=1)  # Expires in 1 second
        assert is_token_expired(token) is False


class TestGetTokenExpiry:
    """Tests for get_token_expiry function."""

    def test_extract_expiry_from_valid_token(self):
        """Should extract expiry timestamp from valid token."""
        # Create token that expires 1 hour from now
        exp_time = datetime.now(timezone.utc) + timedelta(hours=1)
        expected_exp = int(exp_time.timestamp())

        token = create_test_token(exp_delta_seconds=3600)
        actual_exp = get_token_expiry(token)

        # Allow 2 second tolerance for test execution time
        assert actual_exp is not None
        assert abs(actual_exp - expected_exp) <= 2

    def test_extract_expiry_from_expired_token(self):
        """Should extract expiry even from expired token."""
        token = create_test_token(exp_delta_seconds=-3600)  # Expired 1 hour ago
        exp = get_token_expiry(token)

        # Should still return the expiry timestamp even if expired
        assert exp is not None
        # The expiry should be in the past (relative to now)
        assert exp < datetime.now(timezone.utc).timestamp()

    def test_invalid_token_returns_none(self):
        """Invalid token should return None."""
        assert get_token_expiry("invalid.token.here") is None

    def test_empty_token_returns_none(self):
        """Empty token should return None."""
        assert get_token_expiry("") is None

    def test_token_without_exp_claim(self):
        """Token without exp claim should return None."""
        # Create token without exp claim
        payload = {"sub": "testuser", "user_id": 1}
        token = jwt.encode(payload, settings.SECRET_KEY, algorithm=settings.ALGORITHM)
        assert get_token_expiry(token) is None
