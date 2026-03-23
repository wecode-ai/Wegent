# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for GitHub version checker."""

from unittest.mock import Mock, patch

import pytest

from executor.services.updater.github_version_checker import GithubVersionChecker
from executor.services.updater.version_checker import UpdateInfo


class TestGithubVersionCheckerInit:
    """Test cases for GithubVersionChecker initialization."""

    def test_init_without_token(self):
        """Test initialization without GitHub token."""
        checker = GithubVersionChecker()
        assert checker.github_token is None

    def test_init_with_token(self):
        """Test initialization with GitHub token."""
        token = "ghp_test_token"
        checker = GithubVersionChecker(github_token=token)
        assert checker.github_token == token


class TestGithubVersionCheckerGetBinaryName:
    """Test cases for get_binary_name static method."""

    def test_get_binary_name_darwin_arm64(self):
        """Test binary name for macOS ARM64."""
        with patch("platform.system", return_value="Darwin"):
            with patch("platform.machine", return_value="arm64"):
                result = GithubVersionChecker.get_binary_name()
                assert result == "wegent-executor-macos-arm64"

    def test_get_binary_name_darwin_x86_64(self):
        """Test binary name for macOS x86_64."""
        with patch("platform.system", return_value="Darwin"):
            with patch("platform.machine", return_value="x86_64"):
                result = GithubVersionChecker.get_binary_name()
                assert result == "wegent-executor-macos-amd64"

    def test_get_binary_name_linux_arm64(self):
        """Test binary name for Linux ARM64."""
        with patch("platform.system", return_value="Linux"):
            with patch("platform.machine", return_value="arm64"):
                result = GithubVersionChecker.get_binary_name()
                assert result == "wegent-executor-linux-arm64"

    def test_get_binary_name_linux_x86_64(self):
        """Test binary name for Linux x86_64."""
        with patch("platform.system", return_value="Linux"):
            with patch("platform.machine", return_value="x86_64"):
                result = GithubVersionChecker.get_binary_name()
                assert result == "wegent-executor-linux-amd64"

    def test_get_binary_name_windows_amd64(self):
        """Test binary name for Windows AMD64."""
        with patch("platform.system", return_value="Windows"):
            with patch("platform.machine", return_value="AMD64"):
                result = GithubVersionChecker.get_binary_name()
                assert result == "wegent-executor-windows-amd64"


class TestGithubVersionCheckerCheckForUpdates:
    """Test cases for check_for_updates method."""

    @pytest.fixture
    def mock_release_response(self):
        """Fixture for mock GitHub release API response."""
        return {
            "tag_name": "v1.6.6",
            "name": "Release 1.6.6",
            "assets": [
                {
                    "name": "wegent-executor-macos-arm64",
                    "browser_download_url": "https://github.com/wecode-ai/Wegent/releases/download/v1.6.6/wegent-executor-macos-arm64",
                },
                {
                    "name": "wegent-executor-linux-amd64",
                    "browser_download_url": "https://github.com/wecode-ai/Wegent/releases/download/v1.6.6/wegent-executor-linux-amd64",
                },
            ],
        }

    @pytest.mark.asyncio
    async def test_update_available(self, mock_release_response):
        """Test when a newer version is available."""
        checker = GithubVersionChecker()

        mock_response = Mock()
        mock_response.json.return_value = mock_release_response
        mock_response.raise_for_status.return_value = None

        with patch(
            "executor.services.updater.github_version_checker.traced_session"
        ) as mock_session:
            mock_session.return_value.get.return_value = mock_response
            with patch.object(
                checker, "get_binary_name", return_value="wegent-executor-macos-arm64"
            ):
                result = await checker.check_for_updates("1.0.0")

                assert isinstance(result, UpdateInfo)
                assert result.version == "1.6.6"
                assert "wegent-executor-macos-arm64" in result.url

    @pytest.mark.asyncio
    async def test_already_latest(self, mock_release_response):
        """Test when already on the latest version."""
        checker = GithubVersionChecker()

        mock_response = Mock()
        mock_response.json.return_value = mock_release_response
        mock_response.raise_for_status.return_value = None

        with patch(
            "executor.services.updater.github_version_checker.traced_session"
        ) as mock_session:
            mock_session.return_value.get.return_value = mock_response
            with patch.object(
                checker, "get_binary_name", return_value="wegent-executor-macos-arm64"
            ):
                result = await checker.check_for_updates("1.6.6")

                assert result is None

    @pytest.mark.asyncio
    async def test_ahead_of_latest(self, mock_release_response):
        """Test when current version is ahead of latest."""
        checker = GithubVersionChecker()

        mock_response = Mock()
        mock_response.json.return_value = mock_release_response
        mock_response.raise_for_status.return_value = None

        with patch(
            "executor.services.updater.github_version_checker.traced_session"
        ) as mock_session:
            mock_session.return_value.get.return_value = mock_response
            with patch.object(
                checker, "get_binary_name", return_value="wegent-executor-macos-arm64"
            ):
                result = await checker.check_for_updates("2.0.0")

                assert result is None

    @pytest.mark.asyncio
    async def test_version_without_v_prefix(self):
        """Test version extraction without 'v' prefix."""
        checker = GithubVersionChecker()

        mock_response = Mock()
        mock_response.json.return_value = {
            "tag_name": "1.6.6",  # No 'v' prefix
            "assets": [
                {
                    "name": "wegent-executor-macos-arm64",
                    "browser_download_url": "https://example.com/download",
                }
            ],
        }
        mock_response.raise_for_status.return_value = None

        with patch(
            "executor.services.updater.github_version_checker.traced_session"
        ) as mock_session:
            mock_session.return_value.get.return_value = mock_response
            with patch.object(
                checker, "get_binary_name", return_value="wegent-executor-macos-arm64"
            ):
                result = await checker.check_for_updates("1.0.0")

                assert result.version == "1.6.6"

    @pytest.mark.asyncio
    async def test_binary_not_found_for_platform(self, mock_release_response):
        """Test when binary is not available for current platform."""
        checker = GithubVersionChecker()

        mock_response = Mock()
        mock_response.json.return_value = mock_release_response
        mock_response.raise_for_status.return_value = None

        with patch(
            "executor.services.updater.github_version_checker.traced_session"
        ) as mock_session:
            mock_session.return_value.get.return_value = mock_response
            # Simulate a platform not in the release assets
            with patch.object(
                checker, "get_binary_name", return_value="wegent-executor-freebsd-amd64"
            ):
                result = await checker.check_for_updates("1.0.0")

                assert result is None

    @pytest.mark.asyncio
    async def test_rate_limit_error(self):
        """Test handling of GitHub API rate limit (403)."""
        checker = GithubVersionChecker()

        mock_response = Mock()
        mock_response.raise_for_status.side_effect = Exception(
            "403 Client Error: rate limit exceeded"
        )

        with patch(
            "executor.services.updater.github_version_checker.traced_session"
        ) as mock_session:
            mock_session.return_value.get.return_value = mock_response
            with patch("builtins.print"):
                result = await checker.check_for_updates("1.0.0")

                assert result is None

    @pytest.mark.asyncio
    async def test_repo_not_found_error(self):
        """Test handling of 404 error."""
        checker = GithubVersionChecker()

        mock_response = Mock()
        mock_response.raise_for_status.side_effect = Exception(
            "404 Client Error: Not Found"
        )

        with patch(
            "executor.services.updater.github_version_checker.traced_session"
        ) as mock_session:
            mock_session.return_value.get.return_value = mock_response
            with patch("builtins.print"):
                result = await checker.check_for_updates("1.0.0")

                assert result is None

    @pytest.mark.asyncio
    async def test_network_error(self):
        """Test handling of network errors."""
        checker = GithubVersionChecker()

        with patch(
            "executor.services.updater.github_version_checker.traced_session"
        ) as mock_session:
            mock_session.return_value.get.side_effect = Exception("Connection timeout")
            with patch("builtins.print"):
                result = await checker.check_for_updates("1.0.0")

                assert result is None


class TestGithubVersionCheckerHeaders:
    """Test cases for request headers."""

    @pytest.mark.asyncio
    async def test_request_without_token(self):
        """Test that request is made without Authorization header when no token."""
        checker = GithubVersionChecker()

        mock_response = Mock()
        mock_response.json.return_value = {"tag_name": "v1.0.0", "assets": []}
        mock_response.raise_for_status.return_value = None

        with patch(
            "executor.services.updater.github_version_checker.traced_session"
        ) as mock_session:
            mock_session.return_value.get.return_value = mock_response
            with patch.object(
                checker, "get_binary_name", return_value="wegent-executor-macos-arm64"
            ):
                await checker.check_for_updates("1.0.0")

                call_kwargs = mock_session.return_value.get.call_args.kwargs
                headers = call_kwargs.get("headers", {})
                assert "Authorization" not in headers
                assert headers["Accept"] == "application/vnd.github+json"

    @pytest.mark.asyncio
    async def test_request_with_token(self):
        """Test that request includes Authorization header when token is provided."""
        token = "ghp_test_token"
        checker = GithubVersionChecker(github_token=token)

        mock_response = Mock()
        mock_response.json.return_value = {"tag_name": "v1.0.0", "assets": []}
        mock_response.raise_for_status.return_value = None

        with patch(
            "executor.services.updater.github_version_checker.traced_session"
        ) as mock_session:
            mock_session.return_value.get.return_value = mock_response
            with patch.object(
                checker, "get_binary_name", return_value="wegent-executor-macos-arm64"
            ):
                await checker.check_for_updates("1.0.0")

                call_kwargs = mock_session.return_value.get.call_args.kwargs
                headers = call_kwargs.get("headers", {})
                assert headers["Authorization"] == f"Bearer {token}"
                assert headers["Accept"] == "application/vnd.github+json"
