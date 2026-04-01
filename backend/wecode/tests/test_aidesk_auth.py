# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Unit tests for Aidesk authentication service.
"""

import hashlib
import time
from unittest.mock import patch

import pytest

from wecode.service.aidesk_auth_service import AideskAuthService


class TestAideskAuthService:
    """Test cases for AideskAuthService."""

    def setup_method(self):
        """Set up test fixtures."""
        self.service = AideskAuthService()
        # Mock the config for testing
        self.service.config.secret_key = "test-secret-key"
        self.service.config.timestamp_window = 300

    def test_calculate_signature(self):
        """Test signature calculation matches expected format."""
        source = "aidesk"
        username = "testuser"
        timestamp = "1730000000"

        # Calculate expected signature manually
        expected_str = (
            f"source={source}&timestamp={timestamp}&username={username}"
            f"&secret_key=test-secret-key"
        )
        expected_sign = hashlib.md5(expected_str.encode("utf-8")).hexdigest().lower()

        actual_sign = self.service._calculate_signature(source, username, timestamp)
        assert actual_sign == expected_sign

    def test_calculate_signature_strips_whitespace(self):
        """Test that signature calculation strips whitespace from values."""
        source = " aidesk "
        username = " testuser "
        timestamp = " 1730000000 "

        # Calculate expected signature with stripped values
        expected_str = (
            "source=aidesk&timestamp=1730000000&username=testuser"
            "&secret_key=test-secret-key"
        )
        expected_sign = hashlib.md5(expected_str.encode("utf-8")).hexdigest().lower()

        actual_sign = self.service._calculate_signature(source, username, timestamp)
        assert actual_sign == expected_sign

    def test_verify_signature_success(self):
        """Test successful signature verification."""
        source = "aidesk"
        username = "testuser"
        timestamp = str(int(time.time()))
        sign = self.service._calculate_signature(source, username, timestamp)

        is_valid, error = self.service.verify_signature(
            source, username, timestamp, sign
        )
        assert is_valid is True
        assert error is None

    def test_verify_signature_expired_timestamp(self):
        """Test signature verification fails for expired timestamp."""
        source = "aidesk"
        username = "testuser"
        # 10 minutes ago (beyond 300 second window)
        timestamp = str(int(time.time()) - 600)
        sign = self.service._calculate_signature(source, username, timestamp)

        is_valid, error = self.service.verify_signature(
            source, username, timestamp, sign
        )
        assert is_valid is False
        assert error is not None
        assert "expired" in error.lower()

    def test_verify_signature_future_timestamp(self):
        """Test signature verification fails for future timestamp beyond window."""
        source = "aidesk"
        username = "testuser"
        # 10 minutes in the future (beyond 300 second window)
        timestamp = str(int(time.time()) + 600)
        sign = self.service._calculate_signature(source, username, timestamp)

        is_valid, error = self.service.verify_signature(
            source, username, timestamp, sign
        )
        assert is_valid is False
        assert error is not None
        assert "expired" in error.lower()

    def test_verify_signature_invalid_signature(self):
        """Test signature verification fails for invalid signature."""
        source = "aidesk"
        username = "testuser"
        timestamp = str(int(time.time()))
        sign = "invalid_signature_12345678901234"

        is_valid, error = self.service.verify_signature(
            source, username, timestamp, sign
        )
        assert is_valid is False
        assert error is not None
        assert "invalid" in error.lower()

    def test_verify_signature_invalid_timestamp_format(self):
        """Test signature verification fails for invalid timestamp format."""
        source = "aidesk"
        username = "testuser"
        timestamp = "not_a_number"
        sign = "any_signature"

        is_valid, error = self.service.verify_signature(
            source, username, timestamp, sign
        )
        assert is_valid is False
        assert error is not None
        assert "timestamp" in error.lower()

    def test_verify_signature_no_secret_key(self):
        """Test signature verification fails when secret key is not configured."""
        self.service.config.secret_key = ""

        source = "aidesk"
        username = "testuser"
        timestamp = str(int(time.time()))
        sign = "any_signature"

        is_valid, error = self.service.verify_signature(
            source, username, timestamp, sign
        )
        assert is_valid is False
        assert error is not None
        assert "not configured" in error.lower()

    def test_verify_signature_case_insensitive(self):
        """Test that signature comparison is case-insensitive."""
        # Restore secret key for this test
        self.service.config.secret_key = "test-secret-key"

        source = "aidesk"
        username = "testuser"
        timestamp = str(int(time.time()))
        sign = self.service._calculate_signature(source, username, timestamp)

        # Test with uppercase signature
        is_valid, error = self.service.verify_signature(
            source, username, timestamp, sign.upper()
        )
        assert is_valid is True
        assert error is None

    def test_verify_signature_within_window(self):
        """Test signature verification succeeds within timestamp window."""
        source = "aidesk"
        username = "testuser"
        # 2 minutes ago (within 300 second window)
        timestamp = str(int(time.time()) - 120)
        sign = self.service._calculate_signature(source, username, timestamp)

        is_valid, error = self.service.verify_signature(
            source, username, timestamp, sign
        )
        assert is_valid is True
        assert error is None

    def test_verify_signature_at_window_boundary(self):
        """Test signature verification at exact window boundary."""
        source = "aidesk"
        username = "testuser"
        # Exactly at 300 second boundary
        timestamp = str(int(time.time()) - 300)
        sign = self.service._calculate_signature(source, username, timestamp)

        is_valid, error = self.service.verify_signature(
            source, username, timestamp, sign
        )
        assert is_valid is True
        assert error is None

    def test_verify_signature_just_outside_window(self):
        """Test signature verification fails just outside window."""
        source = "aidesk"
        username = "testuser"
        # 301 seconds ago (just outside 300 second window)
        timestamp = str(int(time.time()) - 301)
        sign = self.service._calculate_signature(source, username, timestamp)

        is_valid, error = self.service.verify_signature(
            source, username, timestamp, sign
        )
        assert is_valid is False
        assert error is not None
