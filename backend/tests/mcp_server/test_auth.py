# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for task token authentication."""

from datetime import datetime, timedelta, timezone

import pytest

from app.mcp_server.auth import (
    TaskTokenInfo,
    create_task_token,
    extract_token_from_header,
    get_user_from_task_token,
    verify_task_token,
)


class TestCreateTaskToken:
    """Tests for create_task_token function."""

    def test_create_token_success(self):
        """Test successful token creation."""
        token = create_task_token(
            task_id=123,
            subtask_id=456,
            user_id=789,
            user_name="testuser",
        )
        assert token is not None
        assert isinstance(token, str)
        assert len(token) > 0

    def test_create_token_with_custom_expiry(self):
        """Test token creation with custom expiry."""
        token = create_task_token(
            task_id=1,
            subtask_id=2,
            user_id=3,
            user_name="user",
            expires_delta_minutes=60,  # 1 hour
        )
        assert token is not None

        # Verify token can be decoded
        info = verify_task_token(token)
        assert info is not None
        assert info.task_id == 1
        assert info.subtask_id == 2
        assert info.user_id == 3
        assert info.user_name == "user"


class TestVerifyTaskToken:
    """Tests for verify_task_token function."""

    def test_verify_valid_token(self):
        """Test verification of a valid token."""
        token = create_task_token(
            task_id=100,
            subtask_id=200,
            user_id=300,
            user_name="validuser",
        )

        info = verify_task_token(token)
        assert info is not None
        assert isinstance(info, TaskTokenInfo)
        assert info.task_id == 100
        assert info.subtask_id == 200
        assert info.user_id == 300
        assert info.user_name == "validuser"

    def test_verify_invalid_token(self):
        """Test verification of an invalid token."""
        info = verify_task_token("invalid-token")
        assert info is None

    def test_verify_empty_token(self):
        """Test verification of an empty token."""
        info = verify_task_token("")
        assert info is None

    def test_verify_malformed_jwt(self):
        """Test verification of a malformed JWT."""
        # Valid base64 but not a valid JWT
        info = verify_task_token("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9")
        assert info is None


class TestGetUserFromTaskToken:
    """Tests for get_user_from_task_token function."""

    def test_get_user_from_valid_token(self):
        """Test extracting user_id from a valid token."""
        token = create_task_token(
            task_id=1,
            subtask_id=2,
            user_id=42,
            user_name="user42",
        )

        user_id = get_user_from_task_token(token)
        assert user_id == 42

    def test_get_user_from_invalid_token(self):
        """Test extracting user_id from an invalid token."""
        user_id = get_user_from_task_token("invalid")
        assert user_id is None


class TestExtractTokenFromHeader:
    """Tests for extract_token_from_header function."""

    def test_extract_bearer_token(self):
        """Test extracting token from Bearer authorization header."""
        token = extract_token_from_header("Bearer my-secret-token")
        assert token == "my-secret-token"

    def test_extract_bearer_token_lowercase(self):
        """Test extracting token with lowercase bearer."""
        token = extract_token_from_header("bearer my-token")
        assert token == "my-token"

    def test_extract_empty_header(self):
        """Test with empty header."""
        token = extract_token_from_header("")
        assert token is None

    def test_extract_no_bearer_prefix(self):
        """Test header without Bearer prefix."""
        token = extract_token_from_header("my-token")
        assert token is None

    def test_extract_multiple_spaces(self):
        """Test header with invalid format (multiple parts)."""
        token = extract_token_from_header("Bearer token extra")
        assert token is None
