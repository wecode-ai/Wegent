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

    def test_version_flag_long(self) -> None:
        """Test that --version flag prints version and exits."""
        result = subprocess.run(
            [sys.executable, "-m", "executor.main", "--version"],
            capture_output=True,
            text=True,
            cwd=str(PROJECT_ROOT),
            timeout=30,
        )
        assert result.returncode == 0
        assert result.stdout.strip() == get_version()

    def test_version_flag_short(self) -> None:
        """Test that -v flag prints version and exits."""
        result = subprocess.run(
            [sys.executable, "-m", "executor.main", "-v"],
            capture_output=True,
            text=True,
            cwd=str(PROJECT_ROOT),
            timeout=30,
        )
        assert result.returncode == 0
        assert result.stdout.strip() == get_version()

    def test_version_output_format(self) -> None:
        """Test that version output is just the version number without prefix/suffix."""
        result = subprocess.run(
            [sys.executable, "-m", "executor.main", "--version"],
            capture_output=True,
            text=True,
            cwd=str(PROJECT_ROOT),
            timeout=30,
        )
        version_output = result.stdout.strip()
        # Version should be a simple semver format (e.g., "1.0.0")
        assert version_output
        # Should not contain any prefix like "version:" or "v"
        assert not version_output.startswith("v")
        assert ":" not in version_output
        assert "version" not in version_output.lower()

    def test_version_matches_get_version(self) -> None:
        """Test that CLI version output matches get_version() function."""
        expected_version = get_version()
        result = subprocess.run(
            [sys.executable, "-m", "executor.main", "--version"],
            capture_output=True,
            text=True,
            cwd=str(PROJECT_ROOT),
            timeout=30,
        )
        assert result.stdout.strip() == expected_version


class TestHandleVersionFlag:
    """Test _handle_version_flag function directly."""

    def test_handle_version_flag_with_version(self) -> None:
        """Test that _handle_version_flag exits when --version is present in non-frozen mode."""
        with patch.object(sys, "argv", ["main.py", "--version"]):
            with patch.object(sys, "frozen", False, create=True):
                with pytest.raises(SystemExit) as exc_info:
                    from executor.main import _handle_version_flag

                    _handle_version_flag()
                assert exc_info.value.code == 0

    def test_handle_version_flag_with_v(self) -> None:
        """Test that _handle_version_flag exits when -v is present in non-frozen mode."""
        with patch.object(sys, "argv", ["main.py", "-v"]):
            with patch.object(sys, "frozen", False, create=True):
                with pytest.raises(SystemExit) as exc_info:
                    from executor.main import _handle_version_flag

                    _handle_version_flag()
                assert exc_info.value.code == 0

    def test_handle_version_flag_without_flag(self) -> None:
        """Test that _handle_version_flag does nothing without version flag."""
        with patch.object(sys, "argv", ["main.py"]):
            from executor.main import _handle_version_flag

            # Should not raise SystemExit
            _handle_version_flag()

    def test_handle_version_flag_with_other_args(self) -> None:
        """Test that _handle_version_flag does nothing with other arguments."""
        with patch.object(sys, "argv", ["main.py", "--help"]):
            from executor.main import _handle_version_flag

            # Should not raise SystemExit
            _handle_version_flag()

    def test_handle_version_flag_skipped_in_frozen_mode(self) -> None:
        """Test that _handle_version_flag skips processing in frozen (PyInstaller) mode."""
        with patch.object(sys, "argv", ["main.py", "--version"]):
            with patch.object(sys, "frozen", True, create=True):
                from executor.main import _handle_version_flag

                # Should NOT exit in frozen mode (handled by runtime hook)
                _handle_version_flag()


class TestModuleImportSafety:
    """Test that importing executor.main doesn't cause unintended side effects."""

    def test_import_with_v_flag_does_not_exit(self) -> None:
        """Test that importing executor.main with -v in sys.argv doesn't exit.

        This ensures pytest -v and similar commands work correctly.
        """
        original_argv = sys.argv.copy()
        try:
            sys.argv = ["pytest", "-v", "test_file.py"]
            # This import should NOT cause os._exit or any exit
            import importlib

            import executor.main

            importlib.reload(executor.main)
            # If we reach here, the import didn't exit - which is correct behavior
        finally:
            sys.argv = original_argv


class TestRuntimeHook:
    """Test the PyInstaller runtime hook."""

    def test_runtime_hook_file_exists(self) -> None:
        """Test that the runtime hook file exists."""
        hook_path = PROJECT_ROOT / "executor" / "hooks" / "rthook_version.py"
        assert hook_path.exists(), f"Runtime hook not found at {hook_path}"

    def test_runtime_hook_has_version_handling(self) -> None:
        """Test that the runtime hook contains version handling code."""
        hook_path = PROJECT_ROOT / "executor" / "hooks" / "rthook_version.py"
        content = hook_path.read_text()
        assert "--version" in content
        assert "-v" in content
        assert "os._exit" in content
