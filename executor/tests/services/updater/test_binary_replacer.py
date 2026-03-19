# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for binary_replacer module."""

import os
import stat
from pathlib import Path
from unittest.mock import Mock, patch

import pytest
import requests

from executor.services.updater.binary_replacer import BinaryReplacer


class TestBinaryReplacer:
    """Test cases for BinaryReplacer class."""

    def test_init(self):
        """Test BinaryReplacer initialization."""
        replacer = BinaryReplacer("https://example.com/download", "token123")
        assert replacer.download_url == "https://example.com/download"
        assert replacer.auth_token == "token123"

    @patch("executor.services.updater.binary_replacer.traced_session")
    @patch("tempfile.mkstemp")
    @patch("os.close")
    def test_download_binary_success(self, mock_close, mock_mkstemp, mock_session_class):
        """Test successful binary download."""
        mock_response = Mock()
        mock_response.headers = {"content-length": "1024"}
        mock_response.iter_content.return_value = [b"chunk1", b"chunk2"]
        mock_response.raise_for_status = Mock()

        mock_session = Mock()
        mock_session.get.return_value = mock_response
        mock_session_class.return_value = mock_session

        mock_mkstemp.return_value = (3, "/tmp/wegent-executor-new-123")

        replacer = BinaryReplacer("https://example.com/download", "token123")

        progress_calls = []

        def progress_callback(downloaded, total):
            progress_calls.append((downloaded, total))

        with patch("builtins.open", create=True) as mock_open:
            mock_file = Mock()
            mock_open.return_value.__enter__ = Mock(return_value=mock_file)
            mock_open.return_value.__exit__ = Mock(return_value=False)

            result = replacer.download_binary(progress_callback)

            assert result == Path("/tmp/wegent-executor-new-123")
            mock_session.get.assert_called_once_with(
                "https://example.com/download",
                headers={"PRIVATE-TOKEN": "token123"},
                timeout=300,
                stream=True,
            )
            assert len(progress_calls) == 2

    @patch("executor.services.updater.binary_replacer.traced_session")
    def test_download_binary_http_error(self, mock_session_class):
        """Test handling HTTP error during download."""
        mock_session = Mock()
        mock_session.get.side_effect = requests.HTTPError("404 Not Found")
        mock_session_class.return_value = mock_session

        replacer = BinaryReplacer("https://example.com/download", "token123")

        with pytest.raises(RuntimeError, match="Failed to download binary"):
            replacer.download_binary()

    @patch("executor.services.updater.binary_replacer.traced_session")
    def test_download_binary_timeout(self, mock_session_class):
        """Test handling timeout during download."""
        mock_session = Mock()
        mock_session.get.side_effect = requests.Timeout("Connection timeout")
        mock_session_class.return_value = mock_session

        replacer = BinaryReplacer("https://example.com/download", "token123")

        with pytest.raises(RuntimeError, match="Failed to download binary"):
            replacer.download_binary()

    @patch("shutil.copy2")
    @patch("os.chmod")
    @patch("os.replace")
    def test_replace_binary_success(self, mock_replace, mock_chmod, mock_copy2):
        """Test successful binary replacement."""
        new_binary = Path("/tmp/new-binary")
        current_binary = Path("/usr/local/bin/wegent-executor")

        # Create mock files
        with patch.object(Path, "exists", return_value=True):
            replacer = BinaryReplacer("https://example.com/download", "token")
            result = replacer.replace_binary(new_binary, current_binary)

            assert result is True
            mock_copy2.assert_called_once()
            mock_chmod.assert_called_once_with(
                new_binary,
                stat.S_IRWXU | stat.S_IRGRP | stat.S_IXGRP | stat.S_IROTH | stat.S_IXOTH,
            )
            mock_replace.assert_called_once_with(new_binary, current_binary)

    @patch("shutil.copy2")
    @patch("os.chmod")
    @patch("os.replace")
    def test_replace_binary_permission_error(self, mock_replace, mock_chmod, mock_copy2):
        """Test handling permission error during replacement."""
        new_binary = Path("/tmp/new-binary")
        current_binary = Path("/usr/local/bin/wegent-executor")

        mock_replace.side_effect = PermissionError("Permission denied")

        with patch.object(Path, "exists", return_value=True):
            with patch.object(Path, "unlink") as mock_unlink:
                replacer = BinaryReplacer("https://example.com/download", "token")
                result = replacer.replace_binary(new_binary, current_binary)

                assert result is False

    def test_cleanup_backup_success(self):
        """Test successful backup cleanup."""
        current_binary = Path("/usr/local/bin/wegent-executor")
        backup_path = Path("/usr/local/bin/wegent-executor.backup")

        with patch.object(Path, "exists", return_value=True):
            with patch.object(Path, "unlink") as mock_unlink:
                replacer = BinaryReplacer("https://example.com/download", "token")
                result = replacer.cleanup_backup(current_binary)

                assert result is True
                mock_unlink.assert_called_once()

    def test_cleanup_backup_no_backup(self):
        """Test cleanup when backup doesn't exist."""
        current_binary = Path("/usr/local/bin/wegent-executor")

        with patch.object(Path, "exists", return_value=False):
            replacer = BinaryReplacer("https://example.com/download", "token")
            result = replacer.cleanup_backup(current_binary)

            assert result is True

    def test_format_progress_bar_with_total(self):
        """Test progress bar formatting with known total."""
        result = BinaryReplacer.format_progress_bar(
            downloaded=25 * 1024 * 1024, total=50 * 1024 * 1024, width=40
        )

        assert "50%" in result
        assert "25 MB / 50 MB" in result
        assert "[" in result
        assert "]" in result

    def test_format_progress_bar_without_total(self):
        """Test progress bar formatting without known total."""
        result = BinaryReplacer.format_progress_bar(
            downloaded=25 * 1024 * 1024, total=None, width=40
        )

        assert "25 MB downloaded" in result
        assert "[" in result
        assert "]" in result

    def test_format_progress_bar_100_percent(self):
        """Test progress bar formatting at 100%."""
        result = BinaryReplacer.format_progress_bar(
            downloaded=50 * 1024 * 1024, total=50 * 1024 * 1024, width=40
        )

        assert "100%" in result
        assert "50 MB / 50 MB" in result
