# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the --version CLI flag functionality."""

import subprocess
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

from executor.version import get_version

# Get the project root directory dynamically
PROJECT_ROOT = Path(__file__).parent.parent.parent


class TestVersionCLI:
    """Test suite for executor --version CLI flag."""

    def test_version_flag_long(self):
        """Test that --version flag prints version and exits."""
        result = subprocess.run(
            [sys.executable, "-m", "executor.main", "--version"],
            capture_output=True,
            text=True,
            cwd=str(PROJECT_ROOT),
        )
        assert result.returncode == 0
        assert result.stdout.strip() == get_version()

    def test_version_flag_short(self):
        """Test that -v flag prints version and exits."""
        result = subprocess.run(
            [sys.executable, "-m", "executor.main", "-v"],
            capture_output=True,
            text=True,
            cwd=str(PROJECT_ROOT),
        )
        assert result.returncode == 0
        assert result.stdout.strip() == get_version()

    def test_version_output_format(self):
        """Test that version output is just the version number without prefix/suffix."""
        result = subprocess.run(
            [sys.executable, "-m", "executor.main", "--version"],
            capture_output=True,
            text=True,
            cwd=str(PROJECT_ROOT),
        )
        version_output = result.stdout.strip()
        # Version should be a simple semver format (e.g., "1.0.0")
        assert version_output
        # Should not contain any prefix like "version:" or "v"
        assert not version_output.startswith("v")
        assert ":" not in version_output
        assert "version" not in version_output.lower()

    def test_version_matches_get_version(self):
        """Test that CLI version output matches get_version() function."""
        expected_version = get_version()
        result = subprocess.run(
            [sys.executable, "-m", "executor.main", "--version"],
            capture_output=True,
            text=True,
            cwd=str(PROJECT_ROOT),
        )
        assert result.stdout.strip() == expected_version


class TestHandleVersionFlag:
    """Test _handle_version_flag function directly."""

    def test_handle_version_flag_with_version(self):
        """Test that _handle_version_flag exits when --version is present."""
        with patch.object(sys, "argv", ["main.py", "--version"]):
            with pytest.raises(SystemExit) as exc_info:
                from executor.main import _handle_version_flag

                _handle_version_flag()
            assert exc_info.value.code == 0

    def test_handle_version_flag_with_v(self):
        """Test that _handle_version_flag exits when -v is present."""
        with patch.object(sys, "argv", ["main.py", "-v"]):
            with pytest.raises(SystemExit) as exc_info:
                from executor.main import _handle_version_flag

                _handle_version_flag()
            assert exc_info.value.code == 0

    def test_handle_version_flag_without_flag(self):
        """Test that _handle_version_flag does nothing without version flag."""
        with patch.object(sys, "argv", ["main.py"]):
            from executor.main import _handle_version_flag

            # Should not raise SystemExit
            _handle_version_flag()

    def test_handle_version_flag_with_other_args(self):
        """Test that _handle_version_flag does nothing with other arguments."""
        with patch.object(sys, "argv", ["main.py", "--help"]):
            from executor.main import _handle_version_flag

            # Should not raise SystemExit
            _handle_version_flag()
