# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for updater_service module."""

import shutil
import sys
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

import pytest

from executor.config.device_config import UpdateConfig
from executor.services.updater.updater_service import UpdateResult, UpdaterService
from executor.services.updater.version_checker import UpdateInfo


@pytest.fixture
def default_update_config():
    """Fixture for default UpdateConfig (GitHub)."""
    return UpdateConfig(registry="", registry_token="")


@pytest.fixture
def registry_update_config():
    """Fixture for registry UpdateConfig."""
    return UpdateConfig(
        registry="https://example.com/ai-tool-box",
        registry_token=""
    )


class TestUpdaterService:
    """Test cases for UpdaterService class."""

    def test_init(self, default_update_config):
        """Test UpdaterService initialization."""
        service = UpdaterService(update_config=default_update_config)
        assert service.version_checker is not None
        assert service.binary_replacer is None
        assert service.auto_confirm is False
        assert service.update_config.registry == ""
        assert service.update_config.is_registry() is False

    def test_init_with_auto_confirm(self, default_update_config):
        """Test UpdaterService initialization with auto_confirm."""
        service = UpdaterService(update_config=default_update_config, auto_confirm=True)
        assert service.auto_confirm is True

    @pytest.mark.asyncio
    async def test_check_and_update_already_latest(self, default_update_config):
        """Test update check when already on latest version."""
        service = UpdaterService(update_config=default_update_config)

        # Create an async mock for check_for_updates
        async_mock = AsyncMock(return_value=None)

        with patch(
            "executor.version.get_version", return_value="1.0.0"
        ), patch.object(
            service.version_checker, "check_for_updates", async_mock
        ), patch(
            "builtins.print"
        ):

            result = await service.check_and_update()

            assert result.success is True
            assert result.already_latest is True
            assert result.old_version == "1.0.0"

    @pytest.mark.asyncio
    async def test_check_and_update_update_available_user_confirms(self, default_update_config):
        """Test successful update when user confirms."""
        service = UpdaterService(update_config=default_update_config)

        update_info = UpdateInfo(version="1.6.6", url="https://example.com/download")

        # Create an async mock for check_for_updates
        async_mock = AsyncMock(return_value=update_info)

        mock_replacer = Mock()
        mock_replacer.download_binary.return_value = Path("/tmp/new-binary")
        mock_replacer.replace_binary.return_value = True

        with patch(
            "executor.version.get_version", return_value="1.0.0"
        ), patch.object(
            service.version_checker, "check_for_updates", async_mock
        ), patch.object(
            service, "_confirm_update", return_value=True
        ), patch.object(
            service, "_check_disk_space", return_value=True
        ), patch.object(
            service, "_get_current_binary_path", return_value=Path("/bin/wegent-executor")
        ), patch(
            "executor.services.updater.updater_service.BinaryReplacer",
            return_value=mock_replacer,
        ), patch(
            "builtins.print"
        ):

            result = await service.check_and_update()

            assert result.success is True
            assert result.old_version == "1.0.0"
            assert result.new_version == "1.6.6"
            mock_replacer.download_binary.assert_called_once()
            mock_replacer.replace_binary.assert_called_once()

    @pytest.mark.asyncio
    async def test_check_and_update_auto_confirm(self, default_update_config):
        """Test update with auto_confirm bypasses user prompt."""
        service = UpdaterService(update_config=default_update_config, auto_confirm=True)

        update_info = UpdateInfo(version="1.6.6", url="https://example.com/download")

        # Create an async mock for check_for_updates
        async_mock = AsyncMock(return_value=update_info)

        mock_replacer = Mock()
        mock_replacer.download_binary.return_value = Path("/tmp/new-binary")
        mock_replacer.replace_binary.return_value = True

        with patch(
            "executor.version.get_version", return_value="1.0.0"
        ), patch.object(
            service.version_checker, "check_for_updates", async_mock
        ), patch.object(
            service, "_check_disk_space", return_value=True
        ), patch.object(
            service, "_get_current_binary_path", return_value=Path("/bin/wegent-executor")
        ), patch(
            "executor.services.updater.updater_service.BinaryReplacer",
            return_value=mock_replacer,
        ), patch(
            "builtins.print"
        ):
            # _confirm_update should NOT be called when auto_confirm=True
            with patch.object(service, "_confirm_update") as mock_confirm:
                result = await service.check_and_update()

                assert result.success is True
                assert result.old_version == "1.0.0"
                assert result.new_version == "1.6.6"
                mock_confirm.assert_not_called()

    @pytest.mark.asyncio
    async def test_check_and_update_user_declines(self, default_update_config):
        """Test update when user declines."""
        service = UpdaterService(update_config=default_update_config)

        update_info = UpdateInfo(version="1.6.6", url="https://example.com/download")

        # Create an async mock for check_for_updates
        async_mock = AsyncMock(return_value=update_info)

        with patch(
            "executor.version.get_version", return_value="1.0.0"
        ), patch.object(
            service.version_checker, "check_for_updates", async_mock
        ), patch.object(
            service, "_confirm_update", return_value=False
        ), patch.object(
            service, "_check_disk_space", return_value=True
        ), patch(
            "builtins.print"
        ):

            result = await service.check_and_update()

            assert result.success is False
            assert "cancelled by user" in result.error

    @pytest.mark.asyncio
    async def test_check_and_update_insufficient_disk_space(self, default_update_config):
        """Test update when disk space is insufficient."""
        service = UpdaterService(update_config=default_update_config)

        update_info = UpdateInfo(version="1.6.6", url="https://example.com/download")

        # Create an async mock for check_for_updates
        async_mock = AsyncMock(return_value=update_info)

        with patch(
            "executor.version.get_version", return_value="1.0.0"
        ), patch.object(
            service.version_checker, "check_for_updates", async_mock
        ), patch.object(
            service, "_check_disk_space", return_value=False
        ), patch(
            "builtins.print"
        ):

            result = await service.check_and_update()

            assert result.success is False
            assert "Insufficient disk space" in result.error

    @pytest.mark.asyncio
    async def test_check_and_update_download_fails(self, default_update_config):
        """Test update when download fails."""
        service = UpdaterService(update_config=default_update_config)

        update_info = UpdateInfo(version="1.6.6", url="https://example.com/download")

        # Create an async mock for check_for_updates
        async_mock = AsyncMock(return_value=update_info)

        mock_replacer = Mock()
        mock_replacer.download_binary.side_effect = RuntimeError("Network error")

        with patch(
            "executor.version.get_version", return_value="1.0.0"
        ), patch.object(
            service.version_checker, "check_for_updates", async_mock
        ), patch.object(
            service, "_confirm_update", return_value=True
        ), patch.object(
            service, "_check_disk_space", return_value=True
        ), patch(
            "executor.services.updater.updater_service.BinaryReplacer",
            return_value=mock_replacer,
        ), patch(
            "builtins.print"
        ):

            result = await service.check_and_update()

            assert result.success is False
            assert "Network error" in result.error

    @pytest.mark.asyncio
    async def test_check_and_update_replace_fails(self, default_update_config):
        """Test update when binary replacement fails."""
        service = UpdaterService(update_config=default_update_config)

        update_info = UpdateInfo(version="1.6.6", url="https://example.com/download")

        # Create an async mock for check_for_updates
        async_mock = AsyncMock(return_value=update_info)

        mock_replacer = Mock()
        mock_replacer.download_binary.return_value = Path("/tmp/new-binary")
        mock_replacer.replace_binary.return_value = False

        with patch(
            "executor.version.get_version", return_value="1.0.0"
        ), patch.object(
            service.version_checker, "check_for_updates", async_mock
        ), patch.object(
            service, "_confirm_update", return_value=True
        ), patch.object(
            service, "_check_disk_space", return_value=True
        ), patch.object(
            service, "_get_current_binary_path", return_value=Path("/bin/wegent-executor")
        ), patch(
            "executor.services.updater.updater_service.BinaryReplacer",
            return_value=mock_replacer,
        ), patch(
            "builtins.print"
        ):

            result = await service.check_and_update()

            assert result.success is False
            assert "Failed to replace binary" in result.error

    def test_confirm_update_yes(self, default_update_config):
        """Test user confirms update."""
        service = UpdaterService(update_config=default_update_config)

        with patch("builtins.input", return_value="y"):
            result = service._confirm_update()
            assert result is True

    def test_confirm_update_yes_uppercase(self, default_update_config):
        """Test user confirms update with uppercase Y."""
        service = UpdaterService(update_config=default_update_config)

        with patch("builtins.input", return_value="Y"):
            result = service._confirm_update()
            assert result is True

    def test_confirm_update_default(self, default_update_config):
        """Test user accepts default (empty input)."""
        service = UpdaterService(update_config=default_update_config)

        with patch("builtins.input", return_value=""):
            result = service._confirm_update()
            assert result is True

    def test_confirm_update_no(self, default_update_config):
        """Test user declines update."""
        service = UpdaterService(update_config=default_update_config)

        with patch("builtins.input", return_value="n"):
            result = service._confirm_update()
            assert result is False

    def test_confirm_update_keyboard_interrupt(self, default_update_config):
        """Test handling Ctrl+C during confirmation."""
        service = UpdaterService(update_config=default_update_config)

        with patch("builtins.input", side_effect=KeyboardInterrupt):
            result = service._confirm_update()
            assert result is False

    def test_check_disk_space_sufficient(self, default_update_config):
        """Test disk space check with sufficient space."""
        service = UpdaterService(update_config=default_update_config)

        mock_usage = Mock()
        mock_usage.free = 200 * 1024 * 1024  # 200 MB

        with patch.object(shutil, "disk_usage", return_value=mock_usage):
            result = service._check_disk_space()
            assert result is True

    def test_check_disk_space_insufficient(self, default_update_config):
        """Test disk space check with insufficient space."""
        service = UpdaterService(update_config=default_update_config)

        mock_usage = Mock()
        mock_usage.free = 50 * 1024 * 1024  # 50 MB

        with patch.object(shutil, "disk_usage", return_value=mock_usage), patch(
            "builtins.print"
        ):
            result = service._check_disk_space()
            assert result is False

    def test_get_current_binary_path_frozen(self, default_update_config):
        """Test getting binary path when running as frozen binary."""
        service = UpdaterService(update_config=default_update_config)

        with patch.object(sys, "frozen", True, create=True), patch.object(
            sys, "executable", "/usr/local/bin/wegent-executor"
        ):
            result = service._get_current_binary_path()
            assert result == Path("/usr/local/bin/wegent-executor").resolve()

    def test_get_current_binary_path_not_frozen(self, default_update_config):
        """Test getting binary path when running as script."""
        service = UpdaterService(update_config=default_update_config)

        with patch.object(sys, "frozen", False, create=True), patch.object(
            sys, "argv", ["/path/to/executor/main.py"]
        ):
            result = service._get_current_binary_path()
            assert result == Path("/path/to/executor/main.py").resolve()

    def test_print_progress(self, default_update_config):
        """Test progress printing."""
        from executor.services.updater.binary_replacer import BinaryReplacer

        service = UpdaterService(update_config=default_update_config)

        # Mock the static method on BinaryReplacer class
        with patch.object(
            BinaryReplacer, "format_progress_bar", return_value="[====>] 50% (25 MB / 50 MB)"
        ) as mock_format:
            # Set up the service with a mock replacer
            mock_replacer = Mock()
            service.binary_replacer = mock_replacer

            with patch("builtins.print") as mock_print:
                service._print_progress(25 * 1024 * 1024, 50 * 1024 * 1024)

                mock_format.assert_called_once_with(25 * 1024 * 1024, 50 * 1024 * 1024)
                mock_print.assert_called_once_with(
                    "\r[====>] 50% (25 MB / 50 MB)", end="", flush=True
                )


class TestUpdateResult:
    """Test cases for UpdateResult dataclass."""

    def test_default_values(self):
        """Test UpdateResult default values."""
        result = UpdateResult()
        assert result.success is False
        assert result.already_latest is False
        assert result.old_version is None
        assert result.new_version is None
        assert result.error is None

    def test_custom_values(self):
        """Test UpdateResult with custom values."""
        result = UpdateResult(
            success=True,
            already_latest=True,
            old_version="1.0.0",
            new_version="1.6.6",
            error=None,
        )
        assert result.success is True
        assert result.already_latest is True
        assert result.old_version == "1.0.0"
        assert result.new_version == "1.6.6"
        assert result.error is None
