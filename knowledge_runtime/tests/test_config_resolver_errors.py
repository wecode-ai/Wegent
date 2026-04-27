# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for ConfigResolutionError and process_custom_headers_placeholders."""

import pytest

from knowledge_runtime.services.config_resolver import ConfigResolutionError
from shared.utils.placeholder import process_custom_headers_placeholders


class TestConfigResolutionError:
    """Tests for ConfigResolutionError."""

    def test_stores_error_code(self) -> None:
        """Test that error code is stored correctly."""
        error = ConfigResolutionError("config_not_found", "Something was not found")
        assert error.code == "config_not_found"
        assert str(error) == "Something was not found"

    def test_is_value_error(self) -> None:
        """Test that ConfigResolutionError is a ValueError."""
        error = ConfigResolutionError("config_incomplete", "Incomplete config")
        assert isinstance(error, ValueError)

    def test_raises_and_catches(self) -> None:
        """Test that ConfigResolutionError can be raised and caught."""
        with pytest.raises(ConfigResolutionError) as exc_info:
            raise ConfigResolutionError("config_not_found", "KB not found")

        assert exc_info.value.code == "config_not_found"
        assert "KB not found" in str(exc_info.value)


class TestProcessCustomHeadersPlaceholders:
    """Tests for process_custom_headers_placeholders helper."""

    def test_replaces_user_name_placeholder(self) -> None:
        """Test ${user.name} placeholder is replaced."""
        headers = {"X-User": "${user.name}"}
        result = process_custom_headers_placeholders(headers, user_name="alice")
        assert result["X-User"] == "alice"

    def test_replaces_in_mixed_string(self) -> None:
        """Test placeholder replacement within a longer string."""
        headers = {"Authorization": "Bearer ${user.name}-token"}
        result = process_custom_headers_placeholders(headers, user_name="bob")
        assert result["Authorization"] == "Bearer bob-token"

    def test_no_placeholders(self) -> None:
        """Test headers without placeholders pass through unchanged."""
        headers = {"X-Custom": "static-value"}
        result = process_custom_headers_placeholders(headers, user_name="alice")
        assert result["X-Custom"] == "static-value"

    def test_none_user_name(self) -> None:
        """Test placeholder with None user_name uses empty string."""
        headers = {"X-User": "${user.name}"}
        result = process_custom_headers_placeholders(headers, user_name=None)
        assert result["X-User"] == ""

    def test_empty_headers(self) -> None:
        """Test empty headers dict returns empty dict."""
        result = process_custom_headers_placeholders({}, user_name="alice")
        assert result == {}

    def test_none_headers(self) -> None:
        """Test None headers returns None."""
        result = process_custom_headers_placeholders(None, user_name="alice")
        assert result is None

    def test_non_string_values_preserved(self) -> None:
        """Test non-string header values are preserved as-is."""
        headers = {"X-Count": 42, "X-Flag": True}
        result = process_custom_headers_placeholders(headers, user_name="alice")
        assert result["X-Count"] == 42
        assert result["X-Flag"] is True

    def test_multiple_placeholders(self) -> None:
        """Test multiple placeholders in the same header value."""
        headers = {"X-Auth": "user=${user.name}&type=bearer"}
        result = process_custom_headers_placeholders(headers, user_name="charlie")
        assert result["X-Auth"] == "user=charlie&type=bearer"
