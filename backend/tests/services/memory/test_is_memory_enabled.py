# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Unit tests for is_memory_enabled_for_user function."""

import json
from unittest.mock import MagicMock, patch

import pytest


class TestIsMemoryEnabledForUser:
    """Test cases for is_memory_enabled_for_user function."""

    @pytest.fixture
    def mock_user(self) -> MagicMock:
        """Create a mock user object."""
        user = MagicMock()
        user.preferences = None
        return user

    def test_returns_false_when_memory_service_disabled(self, mock_user):
        """When backend has MEMORY_ENABLED=False, should always return False."""
        with patch("app.services.memory.settings.MEMORY_ENABLED", False):
            from app.services.memory import is_memory_enabled_for_user

            # No preferences
            mock_user.preferences = None
            assert is_memory_enabled_for_user(mock_user) is False

            # Preferences with memory_enabled=True
            mock_user.preferences = json.dumps({"memory_enabled": True})
            assert is_memory_enabled_for_user(mock_user) is False

    def test_returns_true_by_default_when_memory_service_enabled(self, mock_user):
        """When backend has MEMORY_ENABLED=True and user has no preference, should return True."""
        with patch("app.services.memory.settings.MEMORY_ENABLED", True):
            from app.services.memory import is_memory_enabled_for_user

            # No preferences at all
            mock_user.preferences = None
            assert is_memory_enabled_for_user(mock_user) is True

            # Empty preferences string
            mock_user.preferences = "{}"
            assert is_memory_enabled_for_user(mock_user) is True

            # Empty dict
            mock_user.preferences = {}
            assert is_memory_enabled_for_user(mock_user) is True

            # Preferences without memory_enabled key
            mock_user.preferences = json.dumps({"send_key": "enter"})
            assert is_memory_enabled_for_user(mock_user) is True

    def test_respects_explicit_user_preference_when_service_enabled(self, mock_user):
        """When user explicitly sets memory_enabled, should respect their choice."""
        with patch("app.services.memory.settings.MEMORY_ENABLED", True):
            from app.services.memory import is_memory_enabled_for_user

            # User explicitly enables memory
            mock_user.preferences = json.dumps({"memory_enabled": True})
            assert is_memory_enabled_for_user(mock_user) is True

            # User explicitly disables memory
            mock_user.preferences = json.dumps({"memory_enabled": False})
            assert is_memory_enabled_for_user(mock_user) is False

    def test_handles_dict_preferences(self, mock_user):
        """Should handle preferences as dict (not JSON string)."""
        with patch("app.services.memory.settings.MEMORY_ENABLED", True):
            from app.services.memory import is_memory_enabled_for_user

            # Dict without memory_enabled
            mock_user.preferences = {"send_key": "cmd_enter"}
            assert is_memory_enabled_for_user(mock_user) is True

            # Dict with memory_enabled=True
            mock_user.preferences = {"memory_enabled": True}
            assert is_memory_enabled_for_user(mock_user) is True

            # Dict with memory_enabled=False
            mock_user.preferences = {"memory_enabled": False}
            assert is_memory_enabled_for_user(mock_user) is False

    def test_handles_invalid_preferences_gracefully(self, mock_user):
        """Should handle invalid preferences and default to True when service is enabled."""
        with patch("app.services.memory.settings.MEMORY_ENABLED", True):
            from app.services.memory import is_memory_enabled_for_user

            # Invalid JSON string
            mock_user.preferences = "not valid json"
            assert is_memory_enabled_for_user(mock_user) is True

            # Non-dict, non-string type (should default to True)
            mock_user.preferences = 12345
            assert is_memory_enabled_for_user(mock_user) is True

            # List type (invalid)
            mock_user.preferences = ["item1", "item2"]
            assert is_memory_enabled_for_user(mock_user) is True

    def test_handles_invalid_preferences_when_service_disabled(self, mock_user):
        """Should return False for invalid preferences when service is disabled."""
        with patch("app.services.memory.settings.MEMORY_ENABLED", False):
            from app.services.memory import is_memory_enabled_for_user

            # Invalid JSON string
            mock_user.preferences = "not valid json"
            assert is_memory_enabled_for_user(mock_user) is False

            # Non-dict type
            mock_user.preferences = 12345
            assert is_memory_enabled_for_user(mock_user) is False

    def test_normalizes_non_boolean_memory_enabled_values(self, mock_user):
        """Should normalize non-boolean memory_enabled values correctly."""
        with patch("app.services.memory.settings.MEMORY_ENABLED", True):
            from app.services.memory import is_memory_enabled_for_user

            # String "true" should be normalized to True
            mock_user.preferences = json.dumps({"memory_enabled": "true"})
            assert is_memory_enabled_for_user(mock_user) is True

            # String "TRUE" (uppercase) should be normalized to True
            mock_user.preferences = json.dumps({"memory_enabled": "TRUE"})
            assert is_memory_enabled_for_user(mock_user) is True

            # String "yes" should be normalized to True
            mock_user.preferences = json.dumps({"memory_enabled": "yes"})
            assert is_memory_enabled_for_user(mock_user) is True

            # String "1" should be normalized to True
            mock_user.preferences = json.dumps({"memory_enabled": "1"})
            assert is_memory_enabled_for_user(mock_user) is True

            # String "on" should be normalized to True
            mock_user.preferences = json.dumps({"memory_enabled": "on"})
            assert is_memory_enabled_for_user(mock_user) is True

            # String "false" should be normalized to False
            mock_user.preferences = json.dumps({"memory_enabled": "false"})
            assert is_memory_enabled_for_user(mock_user) is False

            # String "no" should be normalized to False
            mock_user.preferences = json.dumps({"memory_enabled": "no"})
            assert is_memory_enabled_for_user(mock_user) is False

            # Integer 1 should be normalized to True
            mock_user.preferences = json.dumps({"memory_enabled": 1})
            assert is_memory_enabled_for_user(mock_user) is True

            # Integer 0 should be normalized to False
            mock_user.preferences = json.dumps({"memory_enabled": 0})
            assert is_memory_enabled_for_user(mock_user) is False

            # None value should be normalized to True (default)
            mock_user.preferences = json.dumps({"memory_enabled": None})
            assert is_memory_enabled_for_user(mock_user) is True

            # Dict preferences with non-bool string value
            mock_user.preferences = {"memory_enabled": "yes"}
            assert is_memory_enabled_for_user(mock_user) is True

            # Dict preferences with "false" string
            mock_user.preferences = {"memory_enabled": "false"}
            assert is_memory_enabled_for_user(mock_user) is False
