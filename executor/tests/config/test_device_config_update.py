# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for device config update settings."""

import os
from unittest.mock import patch

import pytest

from executor.config.device_config import (
    DeviceConfig,
    UpdateConfig,
    _apply_env_overrides,
    _create_default_config,
)


class TestUpdateConfig:
    """Test cases for UpdateConfig dataclass."""

    def test_default_values(self):
        """Test UpdateConfig default values."""
        config = UpdateConfig()
        assert config.registry == ""
        assert config.registry_token == ""

    def test_custom_values(self):
        """Test UpdateConfig with custom values."""
        config = UpdateConfig(
            registry="https://example.com/ai-tool-box",
            registry_token="my_registry_token"
        )
        assert config.registry == "https://example.com/ai-tool-box"
        assert config.registry_token == "my_registry_token"

    def test_to_dict(self):
        """Test UpdateConfig serialization to dict."""
        config = UpdateConfig(
            registry="https://example.com/registry",
            registry_token="my_token"
        )
        data = config.to_dict()

        assert data["registry"] == "https://example.com/registry"
        assert data["registry_token"] == "my_token"

    def test_from_dict(self):
        """Test UpdateConfig deserialization from dict."""
        data = {
            "registry": "https://example.com/registry",
            "registry_token": "my_token"
        }
        config = UpdateConfig.from_dict(data)

        assert config.registry == "https://example.com/registry"
        assert config.registry_token == "my_token"

    def test_from_dict_partial(self):
        """Test UpdateConfig from partial dict uses defaults."""
        data = {"registry": "https://example.com/registry"}
        config = UpdateConfig.from_dict(data)

        assert config.registry == "https://example.com/registry"
        assert config.registry_token == ""  # Default

    def test_from_dict_empty(self):
        """Test UpdateConfig from empty dict uses all defaults."""
        config = UpdateConfig.from_dict({})

        assert config.registry == ""
        assert config.registry_token == ""

    def test_from_dict_backward_compat_url(self):
        """Test backward compatibility: old 'url' field maps to 'registry'."""
        data = {
            "url": "https://example.com/registry",
            "token": "my_token"
        }
        config = UpdateConfig.from_dict(data)

        assert config.registry == "https://example.com/registry"
        assert config.registry_token == "my_token"

    def test_from_dict_new_fields_take_precedence(self):
        """Test new field names take precedence over old ones."""
        data = {
            "registry": "https://new.com/registry",
            "url": "https://old.com/registry",
            "registry_token": "new_token",
            "token": "old_token"
        }
        config = UpdateConfig.from_dict(data)

        assert config.registry == "https://new.com/registry"
        assert config.registry_token == "new_token"


class TestUpdateConfigHelpers:
    """Test cases for UpdateConfig helper methods."""

    def test_is_registry_with_registry(self):
        """Test is_registry returns True when registry is set."""
        config = UpdateConfig(registry="https://example.com/registry")
        assert config.is_registry() is True

    def test_is_registry_without_registry(self):
        """Test is_registry returns False when registry is empty."""
        config = UpdateConfig()
        assert config.is_registry() is False

    def test_is_registry_with_env_var(self):
        """Test is_registry returns True when REGISTRY env var is set."""
        config = UpdateConfig()
        with patch.dict(os.environ, {"REGISTRY": "https://example.com/registry"}):
            assert config.is_registry() is True

    def test_get_registry_url_from_config(self):
        """Test get_registry_url returns config registry."""
        config = UpdateConfig(registry="https://example.com/registry")
        assert config.get_registry_url() == "https://example.com/registry"

    def test_get_registry_url_from_env(self):
        """Test get_registry_url falls back to REGISTRY env var."""
        config = UpdateConfig()
        with patch.dict(os.environ, {"REGISTRY": "https://env.com/registry"}):
            assert config.get_registry_url() == "https://env.com/registry"

    def test_get_registry_url_none(self):
        """Test get_registry_url returns None when no registry configured."""
        config = UpdateConfig()
        with patch.dict(os.environ, {}, clear=True):
            assert config.get_registry_url() is None

    def test_get_token_from_config(self):
        """Test get_token returns config registry_token."""
        config = UpdateConfig(registry_token="my_token")
        assert config.get_token() == "my_token"

    def test_get_token_from_env(self):
        """Test get_token falls back to REGISTRY_TOKEN env var."""
        config = UpdateConfig()
        with patch.dict(os.environ, {"REGISTRY_TOKEN": "env_token"}):
            assert config.get_token() == "env_token"

    def test_get_token_none(self):
        """Test get_token returns None when no token configured."""
        config = UpdateConfig()
        with patch.dict(os.environ, {}, clear=True):
            assert config.get_token() is None


class TestDeviceConfigWithUpdate:
    """Test cases for DeviceConfig with update settings."""

    def test_default_update_config(self):
        """Test DeviceConfig includes default UpdateConfig."""
        config = DeviceConfig()

        assert isinstance(config.update, UpdateConfig)
        assert config.update.registry == ""
        assert config.update.registry_token == ""

    def test_to_dict_includes_update(self):
        """Test DeviceConfig serialization includes update config."""
        config = DeviceConfig()
        config.update.registry = "https://example.com"
        config.update.registry_token = "my_token"

        data = config.to_dict()

        assert "update" in data
        assert data["update"]["registry"] == "https://example.com"
        assert data["update"]["registry_token"] == "my_token"

    def test_from_dict_includes_update(self):
        """Test DeviceConfig deserialization includes update config."""
        data = {
            "mode": "local",
            "device_id": "test-id",
            "update": {
                "registry": "https://example.com/registry",
                "registry_token": "my_token"
            }
        }
        config = DeviceConfig.from_dict(data)

        assert config.update.registry == "https://example.com/registry"
        assert config.update.registry_token == "my_token"

    def test_from_dict_missing_update(self):
        """Test DeviceConfig from dict without update uses defaults."""
        data = {
            "mode": "local",
            "device_id": "test-id"
        }
        config = DeviceConfig.from_dict(data)

        assert isinstance(config.update, UpdateConfig)
        assert config.update.registry == ""
        assert config.update.registry_token == ""

    def test_from_dict_backward_compat_update(self):
        """Test DeviceConfig backward compatibility with old update fields."""
        data = {
            "mode": "local",
            "device_id": "test-id",
            "update": {
                "url": "https://example.com/registry",
                "token": "my_token"
            }
        }
        config = DeviceConfig.from_dict(data)

        assert config.update.registry == "https://example.com/registry"
        assert config.update.registry_token == "my_token"


class TestEnvOverridesForUpdate:
    """Test cases for environment variable overrides for update config."""

    def test_registry_env_override(self):
        """Test REGISTRY env var fills empty config value."""
        config = DeviceConfig()
        config.update.registry = ""  # Empty

        with patch.dict(os.environ, {"REGISTRY": "https://example.com/ai-tool-box"}):
            updated_config, should_save = _apply_env_overrides(config)

            assert updated_config.update.registry == "https://example.com/ai-tool-box"
            assert should_save is True  # Should save because it filled empty value

    def test_registry_env_no_override_if_set(self):
        """Test REGISTRY env var takes precedence but doesn't trigger save if set."""
        config = DeviceConfig()
        config.update.registry = "existing_url"

        with patch.dict(os.environ, {"REGISTRY": "https://new.com/registry"}):
            updated_config, should_save = _apply_env_overrides(config)

            # Env var takes precedence
            assert updated_config.update.registry == "https://new.com/registry"
            assert should_save is False  # Should not save if already has value

    def test_registry_token_env_override(self):
        """Test REGISTRY_TOKEN env var fills empty config value."""
        config = DeviceConfig()
        config.update.registry_token = ""  # Empty

        with patch.dict(os.environ, {"REGISTRY_TOKEN": "my_token"}):
            updated_config, should_save = _apply_env_overrides(config)

            assert updated_config.update.registry_token == "my_token"
            assert should_save is True  # Should save because it filled empty value

    def test_registry_token_env_no_override_if_set(self):
        """Test REGISTRY_TOKEN env var takes precedence but doesn't trigger save if set."""
        config = DeviceConfig()
        config.update.registry_token = "existing_token"

        with patch.dict(os.environ, {"REGISTRY_TOKEN": "new_token"}):
            updated_config, should_save = _apply_env_overrides(config)

            # Env var takes precedence
            assert updated_config.update.registry_token == "new_token"
            assert should_save is False  # Should not save if already has value

    def test_all_update_env_vars_together(self):
        """Test all update env vars applied together."""
        config = DeviceConfig()
        config.update.registry = ""
        config.update.registry_token = ""

        env_vars = {
            "REGISTRY": "https://example.com/ai-tool-box",
            "REGISTRY_TOKEN": "my_registry_token"
        }

        with patch.dict(os.environ, env_vars):
            updated_config, should_save = _apply_env_overrides(config)

            assert updated_config.update.registry == "https://example.com/ai-tool-box"
            assert updated_config.update.registry_token == "my_registry_token"
            assert should_save is True  # Filled empty values


class TestCreateDefaultConfigWithUpdate:
    """Test cases for default config creation with update settings."""

    def test_default_config_includes_update(self):
        """Test that default config includes UpdateConfig."""
        config = _create_default_config()

        assert isinstance(config.update, UpdateConfig)
        assert config.update.registry == ""
        assert config.update.registry_token == ""
