# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for process_manager module."""

import json
import os
import sys
import time
from pathlib import Path
from unittest.mock import Mock, patch

import pytest

from executor.services.updater.process_manager import ProcessInfo, ProcessManager


class TestProcessInfo:
    """Test cases for ProcessInfo dataclass."""

    def test_create(self):
        """Test creating ProcessInfo."""
        info = ProcessInfo(pid=1234, start_time=1234567890.0, version="1.0.0")
        assert info.pid == 1234
        assert info.start_time == 1234567890.0
        assert info.version == "1.0.0"


class TestProcessManager:
    """Test cases for ProcessManager class."""

    @pytest.fixture
    def process_manager(self, tmp_path):
        """Create a ProcessManager with temporary PID file location."""
        pm = ProcessManager()
        # Override PID file location for testing
        pm.PID_FILE_DIR = tmp_path
        pm.PID_FILE = tmp_path / "executor.pid"
        return pm

    def test_write_pid_file(self, process_manager):
        """Test writing PID file."""
        result = process_manager.write_pid_file("1.0.0")
        assert result is True
        assert process_manager.PID_FILE.exists()

        # Verify content
        data = json.loads(process_manager.PID_FILE.read_text())
        assert data["pid"] == os.getpid()
        assert data["version"] == "1.0.0"
        assert "start_time" in data

    def test_remove_pid_file(self, process_manager):
        """Test removing PID file."""
        # Write first
        process_manager.write_pid_file("1.0.0")
        assert process_manager.PID_FILE.exists()

        # Remove
        result = process_manager.remove_pid_file()
        assert result is True
        assert not process_manager.PID_FILE.exists()

    def test_remove_pid_file_not_exists(self, process_manager):
        """Test removing PID file that doesn't exist."""
        result = process_manager.remove_pid_file()
        assert result is True

    def test_read_pid_file(self, process_manager):
        """Test reading PID file."""
        # Write PID file
        process_manager.write_pid_file("1.0.0")

        # Read it back
        info = process_manager.read_pid_file()
        assert info is not None
        assert info.pid == os.getpid()
        assert info.version == "1.0.0"

    def test_read_pid_file_not_exists(self, process_manager):
        """Test reading non-existent PID file."""
        info = process_manager.read_pid_file()
        assert info is None

    def test_read_pid_file_invalid_json(self, process_manager):
        """Test reading corrupted PID file."""
        process_manager.PID_FILE_DIR.mkdir(parents=True, exist_ok=True)
        process_manager.PID_FILE.write_text("invalid json")

        info = process_manager.read_pid_file()
        assert info is None
        # File should be removed
        assert not process_manager.PID_FILE.exists()

    def test_is_running_current_process(self, process_manager):
        """Test checking if current process is running."""
        info = ProcessInfo(pid=os.getpid(), start_time=time.time(), version="1.0.0")
        assert process_manager.is_running(info) is True

    def test_is_running_nonexistent_process(self, process_manager):
        """Test checking non-existent process."""
        # Use a very high PID that's unlikely to exist
        info = ProcessInfo(pid=999999, start_time=time.time(), version="1.0.0")
        assert process_manager.is_running(info) is False

    def test_was_running_returns_none_no_file(self, process_manager):
        """Test was_running when no PID file exists."""
        result = process_manager.was_running()
        assert result is None

    def test_was_running_returns_none_same_pid(self, process_manager):
        """Test was_running when PID file contains current process."""
        process_manager.write_pid_file("1.0.0")
        result = process_manager.was_running()
        assert result is None  # Same PID means we're the upgrader, not running executor

    def test_was_running_stale_pid(self, process_manager):
        """Test was_running removes stale PID file."""
        # Create PID file with non-existent PID
        info = ProcessInfo(pid=999999, start_time=time.time(), version="1.0.0")
        process_manager.PID_FILE_DIR.mkdir(parents=True, exist_ok=True)
        process_manager.PID_FILE.write_text(json.dumps(info.__dict__))

        result = process_manager.was_running()
        assert result is None
        # Stale file should be removed
        assert not process_manager.PID_FILE.exists()

    def test_terminate_process_graceful(self, process_manager):
        """Test graceful process termination."""
        mock_handler = Mock()
        mock_handler.terminate_gracefully.return_value = True
        mock_handler.terminate_forcefully.return_value = True
        process_manager._signal_handler = mock_handler

        # Mock _is_process_alive to return True then False
        with patch.object(
            process_manager, "_is_process_alive", side_effect=[True, True, False]
        ):
            result = process_manager.terminate_process(1234, timeout=1)
            assert result is True
            mock_handler.terminate_gracefully.assert_called_once_with(1234)

    def test_terminate_process_forceful(self, process_manager):
        """Test forceful process termination when graceful fails."""
        mock_handler = Mock()
        mock_handler.terminate_gracefully.return_value = True
        mock_handler.terminate_forcefully.return_value = True
        process_manager._signal_handler = mock_handler

        # Simply verify that when process doesn't terminate gracefully,
        # the force kill is attempted
        with patch.object(process_manager, "_is_process_alive", return_value=True):
            result = process_manager.terminate_process(1234, timeout=0.1)
            # Result is False because process never dies, but force kill was attempted
            mock_handler.terminate_forcefully.assert_called_once_with(1234)

    def test_terminate_process_current_process(self, process_manager):
        """Test that we cannot terminate ourselves."""
        result = process_manager.terminate_process(os.getpid())
        assert result is False

    def test_terminate_process_already_dead(self, process_manager):
        """Test terminating already dead process."""
        mock_handler = Mock()
        mock_handler.terminate_gracefully.return_value = False
        process_manager._signal_handler = mock_handler

        with patch.object(process_manager, "_is_process_alive", return_value=False):
            result = process_manager.terminate_process(1234)
            assert result is True  # Already dead is success

    def test_is_process_alive_current_process(self, process_manager):
        """Test checking if current process is alive."""
        assert process_manager._is_process_alive(os.getpid()) is True

    def test_is_process_alive_nonexistent(self, process_manager):
        """Test checking non-existent process."""
        assert process_manager._is_process_alive(999999) is False

    def test_restart_executor_frozen(self, process_manager):
        """Test restart when running as frozen binary."""
        mock_proc = Mock()
        mock_proc.pid = 12345
        mock_proc.poll.return_value = None  # Process is still running

        with patch.object(sys, "frozen", True, create=True):
            with patch.object(sys, "executable", "/usr/bin/wegent-executor"):
                with patch("subprocess.Popen", return_value=mock_proc) as mock_popen:
                    with patch.object(Path, "exists", return_value=True):
                        with patch.object(
                            process_manager, "_is_process_alive", return_value=True
                        ):
                            result = process_manager.restart_executor()
                            assert result is True
                            mock_popen.assert_called_once()

    def test_restart_executor_development(self, process_manager):
        """Test restart in development mode."""
        mock_proc = Mock()
        mock_proc.pid = 12345
        mock_proc.poll.return_value = None  # Process is still running

        with patch.object(sys, "frozen", False, create=True):
            with patch.object(sys, "executable", sys.executable):
                with patch("subprocess.Popen", return_value=mock_proc) as mock_popen:
                    with patch.object(
                        process_manager, "_is_process_alive", return_value=True
                    ):
                        result = process_manager.restart_executor()
                        assert result is True
                        mock_popen.assert_called_once()
                        # Verify command includes python -m executor.main
                        args = mock_popen.call_args[0][0]
                        assert "-m" in args
                        assert "executor.main" in args


class TestProcessManagerIntegration:
    """Integration tests for ProcessManager."""

    @pytest.fixture
    def process_manager(self, tmp_path):
        """Create a ProcessManager with temporary PID file location."""
        pm = ProcessManager()
        pm.PID_FILE_DIR = tmp_path
        pm.PID_FILE = tmp_path / "executor.pid"
        return pm

    def test_full_lifecycle(self, process_manager):
        """Test the full PID file lifecycle."""
        # Write PID file
        assert process_manager.write_pid_file("1.0.0") is True

        # Read it back
        info = process_manager.read_pid_file()
        assert info is not None
        assert info.version == "1.0.0"

        # Check was_running (should be None since it's our own PID)
        running = process_manager.was_running()
        assert running is None

        # Remove PID file
        assert process_manager.remove_pid_file() is True
        assert not process_manager.PID_FILE.exists()

    def test_stale_detection(self, process_manager):
        """Test detection and cleanup of stale PID files."""
        # Create a PID file with a fake PID
        fake_info = ProcessInfo(pid=999998, start_time=time.time(), version="1.0.0")
        process_manager.PID_FILE_DIR.mkdir(parents=True, exist_ok=True)
        process_manager.PID_FILE.write_text(json.dumps(fake_info.__dict__))

        # was_running should detect it's stale and remove it
        result = process_manager.was_running()
        assert result is None
        assert not process_manager.PID_FILE.exists()
