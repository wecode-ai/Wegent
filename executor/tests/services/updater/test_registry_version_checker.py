# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for registry version checker."""

from unittest.mock import Mock, patch

import pytest

from executor.services.updater.registry_version_checker import RegistryVersionChecker
from executor.services.updater.version_checker import UpdateInfo


class TestRegistryVersionCheckerInit:
    """Test cases for RegistryVersionChecker initialization."""

    def test_init_with_no_token(self):
        """Test initialization with no auth token (None)."""
        checker = RegistryVersionChecker(registry_url="https://example.com/ai-tool-box")
        assert checker.registry_url == "https://example.com/ai-tool-box"
        assert checker.auth_token is None

    def test_init_with_custom_token(self):
        """Test initialization with custom auth token."""
        checker = RegistryVersionChecker(
            registry_url="https://example.com/ai-tool-box",
            auth_token="custom_token"
        )
        assert checker.registry_url == "https://example.com/ai-tool-box"
        assert checker.auth_token == "custom_token"

    def test_init_with_none_token_explicit(self):
        """Test initialization with explicitly None auth token."""
        checker = RegistryVersionChecker(
            registry_url="https://example.com/ai-tool-box",
            auth_token=None
        )
        assert checker.registry_url == "https://example.com/ai-tool-box"
        assert checker.auth_token is None


class TestRegistryVersionCheckerGetBinaryName:
    """Test cases for get_binary_name static method."""

    def test_get_binary_name_darwin_arm64(self):
        """Test binary name for macOS ARM64."""
        with patch("platform.system", return_value="Darwin"):
            with patch("platform.machine", return_value="arm64"):
                result = RegistryVersionChecker.get_binary_name()
                assert result == "wegent-executor-macos-arm64"

    def test_get_binary_name_darwin_x86_64(self):
        """Test binary name for macOS x86_64."""
        with patch("platform.system", return_value="Darwin"):
            with patch("platform.machine", return_value="x86_64"):
                result = RegistryVersionChecker.get_binary_name()
                assert result == "wegent-executor-macos-amd64"

    def test_get_binary_name_linux_arm64(self):
        """Test binary name for Linux ARM64."""
        with patch("platform.system", return_value="Linux"):
            with patch("platform.machine", return_value="arm64"):
                result = RegistryVersionChecker.get_binary_name()
                assert result == "wegent-executor-linux-arm64"

    def test_get_binary_name_linux_x86_64(self):
        """Test binary name for Linux x86_64."""
        with patch("platform.system", return_value="Linux"):
            with patch("platform.machine", return_value="x86_64"):
                result = RegistryVersionChecker.get_binary_name()
                assert result == "wegent-executor-linux-amd64"


class TestRegistryVersionCheckerCheckForUpdates:
    """Test cases for check_for_updates method."""

    @pytest.fixture
    def registry_url(self):
        """Fixture for test registry URL."""
        return "https://example.com/ai-tool-box"

    @pytest.fixture
    def mock_registry_response(self):
        """Fixture for mock registry API response."""
        return {
            "version": "1.6.6",
            "url": "https://example.com/ai-tool-box/wegent-executor-macos-arm64/download"
        }

    @pytest.mark.asyncio
    async def test_update_available(self, registry_url, mock_registry_response):
        """Test when a newer version is available."""
        checker = RegistryVersionChecker(registry_url=registry_url)

        mock_response = Mock()
        mock_response.json.return_value = mock_registry_response
        mock_response.raise_for_status.return_value = None

        with patch("executor.services.updater.registry_version_checker.traced_session") as mock_session:
            mock_session.return_value.get.return_value = mock_response
            with patch.object(checker, "get_binary_name", return_value="wegent-executor-macos-arm64"):
                result = await checker.check_for_updates("1.0.0")

                assert isinstance(result, UpdateInfo)
                assert result.version == "1.6.6"
                assert result.url == mock_registry_response["url"]

    @pytest.mark.asyncio
    async def test_already_latest(self, registry_url, mock_registry_response):
        """Test when already on the latest version."""
        checker = RegistryVersionChecker(registry_url=registry_url)

        mock_response = Mock()
        mock_response.json.return_value = mock_registry_response
        mock_response.raise_for_status.return_value = None

        with patch("executor.services.updater.registry_version_checker.traced_session") as mock_session:
            mock_session.return_value.get.return_value = mock_response
            with patch.object(checker, "get_binary_name", return_value="wegent-executor-macos-arm64"):
                result = await checker.check_for_updates("1.6.6")

                assert result is None

    @pytest.mark.asyncio
    async def test_ahead_of_latest(self, registry_url, mock_registry_response):
        """Test when current version is ahead of latest."""
        checker = RegistryVersionChecker(registry_url=registry_url)

        mock_response = Mock()
        mock_response.json.return_value = mock_registry_response
        mock_response.raise_for_status.return_value = None

        with patch("executor.services.updater.registry_version_checker.traced_session") as mock_session:
            mock_session.return_value.get.return_value = mock_response
            with patch.object(checker, "get_binary_name", return_value="wegent-executor-macos-arm64"):
                result = await checker.check_for_updates("2.0.0")

                assert result is None

    @pytest.mark.asyncio
    async def test_invalid_response_missing_version(self, registry_url):
        """Test handling of invalid response missing version."""
        checker = RegistryVersionChecker(registry_url=registry_url)

        mock_response = Mock()
        mock_response.json.return_value = {"url": "https://example.com/download"}  # Missing version
        mock_response.raise_for_status.return_value = None

        with patch("executor.services.updater.registry_version_checker.traced_session") as mock_session:
            mock_session.return_value.get.return_value = mock_response
            with patch.object(checker, "get_binary_name", return_value="wegent-executor-macos-arm64"):
                result = await checker.check_for_updates("1.0.0")

                assert result is None

    @pytest.mark.asyncio
    async def test_invalid_response_missing_url(self, registry_url):
        """Test handling of invalid response missing URL."""
        checker = RegistryVersionChecker(registry_url=registry_url)

        mock_response = Mock()
        mock_response.json.return_value = {"version": "1.6.6"}  # Missing url
        mock_response.raise_for_status.return_value = None

        with patch("executor.services.updater.registry_version_checker.traced_session") as mock_session:
            mock_session.return_value.get.return_value = mock_response
            with patch.object(checker, "get_binary_name", return_value="wegent-executor-macos-arm64"):
                result = await checker.check_for_updates("1.0.0")

                assert result is None

    @pytest.mark.asyncio
    async def test_ssl_error(self, registry_url):
        """Test handling of SSL errors."""
        checker = RegistryVersionChecker(registry_url=registry_url)

        mock_response = Mock()
        mock_response.raise_for_status.side_effect = Exception("SSL certificate verify failed")

        with patch("executor.services.updater.registry_version_checker.traced_session") as mock_session:
            mock_session.return_value.get.return_value = mock_response
            with patch.object(checker, "get_binary_name", return_value="wegent-executor-macos-arm64"):
                result = await checker.check_for_updates("1.0.0")

                assert result is None

    @pytest.mark.asyncio
    async def test_connection_error(self, registry_url):
        """Test handling of connection errors."""
        checker = RegistryVersionChecker(registry_url=registry_url)

        with patch("executor.services.updater.registry_version_checker.traced_session") as mock_session:
            mock_session.return_value.get.side_effect = Exception("Connection refused")
            with patch.object(checker, "get_binary_name", return_value="wegent-executor-macos-arm64"):
                result = await checker.check_for_updates("1.0.0")

                assert result is None

    @pytest.mark.asyncio
    async def test_timeout_error(self, registry_url):
        """Test handling of timeout errors."""
        checker = RegistryVersionChecker(registry_url=registry_url)

        with patch("executor.services.updater.registry_version_checker.traced_session") as mock_session:
            mock_session.return_value.get.side_effect = Exception("Request timeout")
            with patch.object(checker, "get_binary_name", return_value="wegent-executor-macos-arm64"):
                result = await checker.check_for_updates("1.0.0")

                assert result is None


class TestRegistryVersionCheckerBuildApiUrl:
    """Test cases for _build_api_url method."""

    def test_build_api_url_with_base_url(self):
        """Test URL building with base registry URL."""
        checker = RegistryVersionChecker(registry_url="https://example.com/registry")

        with patch.object(checker, "get_binary_name", return_value="wegent-executor-macos-arm64"):
            url = checker._build_api_url()
            assert url == "https://example.com/registry/wegent-executor-macos-arm64/update.json"

    def test_build_api_url_with_trailing_slash(self):
        """Test URL building with trailing slash."""
        checker = RegistryVersionChecker(registry_url="https://example.com/registry/")

        with patch.object(checker, "get_binary_name", return_value="wegent-executor-linux-amd64"):
            url = checker._build_api_url()
            assert url == "https://example.com/registry/wegent-executor-linux-amd64/update.json"

    def test_build_api_url_with_already_complete_path(self):
        """Test URL building when URL already contains platform path (backward compat)."""
        checker = RegistryVersionChecker(
            registry_url="https://example.com/registry/wegent-executor-linux-amd64/update.json"
        )
        url = checker._build_api_url()
        # Should use as-is, not append another binary name
        assert url == "https://example.com/registry/wegent-executor-linux-amd64/update.json"

    def test_build_api_url_ends_with_update_json(self):
        """Test URL building when URL ends with /update.json."""
        checker = RegistryVersionChecker(
            registry_url="https://example.com/some/path/update.json"
        )
        url = checker._build_api_url()
        assert url == "https://example.com/some/path/update.json"

    def test_build_api_url_with_different_platforms(self):
        """Test URL building uses current platform's binary name."""
        checker = RegistryVersionChecker(registry_url="https://example.com/registry")

        platforms = [
            ("wegent-executor-macos-arm64", "https://example.com/registry/wegent-executor-macos-arm64/update.json"),
            ("wegent-executor-linux-amd64", "https://example.com/registry/wegent-executor-linux-amd64/update.json"),
            ("wegent-executor-linux-arm64", "https://example.com/registry/wegent-executor-linux-arm64/update.json"),
        ]

        for binary_name, expected_url in platforms:
            with patch.object(checker, "get_binary_name", return_value=binary_name):
                url = checker._build_api_url()
                assert url == expected_url


class TestRegistryVersionCheckerHeaders:
    """Test cases for request headers."""

    @pytest.mark.asyncio
    async def test_request_includes_private_token_header_when_token_provided(self):
        """Test that request includes PRIVATE-TOKEN header when token is provided."""
        registry_url = "https://example.com/ai-tool-box"
        checker = RegistryVersionChecker(registry_url=registry_url, auth_token="my_token")

        mock_response = Mock()
        mock_response.json.return_value = {"version": "1.0.0", "url": "https://example.com/download"}
        mock_response.raise_for_status.return_value = None

        with patch("executor.services.updater.registry_version_checker.traced_session") as mock_session:
            mock_session.return_value.get.return_value = mock_response
            with patch.object(checker, "get_binary_name", return_value="wegent-executor-macos-arm64"):
                await checker.check_for_updates("0.9.0")

                call_kwargs = mock_session.return_value.get.call_args.kwargs
                headers = call_kwargs.get("headers", {})
                assert "PRIVATE-TOKEN" in headers
                assert headers["PRIVATE-TOKEN"] == "my_token"

    @pytest.mark.asyncio
    async def test_request_excludes_private_token_header_when_no_token(self):
        """Test that request excludes PRIVATE-TOKEN header when no token is provided."""
        registry_url = "https://example.com/ai-tool-box"
        checker = RegistryVersionChecker(registry_url=registry_url, auth_token=None)

        mock_response = Mock()
        mock_response.json.return_value = {"version": "1.0.0", "url": "https://example.com/download"}
        mock_response.raise_for_status.return_value = None

        with patch("executor.services.updater.registry_version_checker.traced_session") as mock_session:
            mock_session.return_value.get.return_value = mock_response
            with patch.object(checker, "get_binary_name", return_value="wegent-executor-macos-arm64"):
                await checker.check_for_updates("0.9.0")

                call_kwargs = mock_session.return_value.get.call_args.kwargs
                headers = call_kwargs.get("headers", {})
                assert "PRIVATE-TOKEN" not in headers
