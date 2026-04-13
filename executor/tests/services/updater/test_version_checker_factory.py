# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for version checker factory."""

from unittest.mock import patch

import pytest

from executor.config.device_config import UpdateConfig
from executor.services.updater.github_version_checker import GithubVersionChecker
from executor.services.updater.registry_version_checker import RegistryVersionChecker
from executor.services.updater.version_checker_factory import create_version_checker


class TestVersionCheckerFactory:
    """Test cases for version checker factory."""

    def test_create_github_checker_default(self):
        """Test factory creates GithubVersionChecker when no registry is set."""
        config = UpdateConfig(registry="", registry_token="")
        checker = create_version_checker(config)

        assert isinstance(checker, GithubVersionChecker)
        assert checker.github_token is None

    def test_create_registry_checker_with_registry(self):
        """Test factory creates RegistryVersionChecker when registry is set."""
        config = UpdateConfig(
            registry="https://example.com/ai-tool-box", registry_token=""
        )
        checker = create_version_checker(config)

        assert isinstance(checker, RegistryVersionChecker)
        assert checker.registry_url == "https://example.com/ai-tool-box"
        assert checker.auth_token is None  # Empty string -> None

    def test_create_registry_checker_with_token(self):
        """Test factory creates RegistryVersionChecker with auth token."""
        config = UpdateConfig(
            registry="https://example.com/ai-tool-box",
            registry_token="my_registry_token",
        )
        checker = create_version_checker(config)

        assert isinstance(checker, RegistryVersionChecker)
        assert checker.registry_url == "https://example.com/ai-tool-box"
        assert checker.auth_token == "my_registry_token"

    def test_create_registry_checker_from_env_var(self):
        """Test factory creates RegistryVersionChecker when REGISTRY env var is set."""
        config = UpdateConfig(registry="", registry_token="")

        with patch.dict("os.environ", {"REGISTRY": "https://env.com/registry"}):
            checker = create_version_checker(config)

        assert isinstance(checker, RegistryVersionChecker)
        assert checker.registry_url == "https://env.com/registry"

    def test_create_registry_checker_with_token_from_env(self):
        """Test factory uses token from REGISTRY_TOKEN env var."""
        config = UpdateConfig(
            registry="https://example.com/registry", registry_token=""
        )

        with patch.dict("os.environ", {"REGISTRY_TOKEN": "env_token"}):
            checker = create_version_checker(config)

        assert isinstance(checker, RegistryVersionChecker)
        assert checker.auth_token == "env_token"

    def test_empty_config_defaults_to_github(self):
        """Test factory defaults to GitHub with empty config."""
        config = UpdateConfig()

        with patch.dict("os.environ", {}, clear=True):
            checker = create_version_checker(config)

        assert isinstance(checker, GithubVersionChecker)

    def test_registry_takes_precedence_over_env(self):
        """Test config registry takes precedence over env var."""
        config = UpdateConfig(registry="https://config.com/registry", registry_token="")

        with patch.dict("os.environ", {"REGISTRY": "https://env.com/registry"}):
            checker = create_version_checker(config)

        assert isinstance(checker, RegistryVersionChecker)
        assert checker.registry_url == "https://config.com/registry"

    def test_error_message_mentions_registry(self):
        """Test error message mentions 'update.registry' and REGISTRY env var."""
        config = UpdateConfig()

        # Mock is_registry to return True but get_registry_url to return None
        # This shouldn't happen in practice, but tests the error message
        with patch.object(config, "is_registry", return_value=True):
            with patch.object(config, "get_registry_url", return_value=None):
                with pytest.raises(ValueError) as exc_info:
                    create_version_checker(config)

        error_msg = str(exc_info.value)
        assert "update.registry" in error_msg
        assert "REGISTRY" in error_msg
