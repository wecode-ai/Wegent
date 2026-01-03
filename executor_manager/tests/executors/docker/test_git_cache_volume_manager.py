# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest
from unittest.mock import patch, MagicMock
import subprocess
from executor_manager.executors.docker.git_cache_volume_manager import (
    get_user_volume_name,
    volume_exists,
    create_user_volume,
    get_volume_metadata,
    update_volume_last_used,
    delete_volume,
    list_user_volumes,
    get_volume_size,
    get_all_user_volume_names,
    _read_last_used_from_volume,
    _read_metadata_from_volume,
    _write_last_used_to_volume,
    _write_metadata_to_volume,
    _initialize_volume_metadata,
    _read_volume_files,
)


class TestVolumeManager:
    """Test cases for volume management"""

    def test_get_user_volume_name(self):
        """Test volume name generation"""
        assert get_user_volume_name(123) == "wegent_git_cache_user_123"
        assert get_user_volume_name(1) == "wegent_git_cache_user_1"
        assert get_user_volume_name(999999) == "wegent_git_cache_user_999999"

    @patch("executor_manager.executors.docker.git_cache_volume_manager.subprocess.run")
    def test_volume_exists_true(self, mock_run):
        """Test volume_exists when volume exists"""
        mock_run.return_value = MagicMock(returncode=0)
        assert volume_exists("wegent_git_cache_user_123") is True
        mock_run.assert_called_once()

    @patch("executor_manager.executors.docker.git_cache_volume_manager.subprocess.run")
    def test_volume_exists_false(self, mock_run):
        """Test volume_exists when volume doesn't exist"""
        mock_run.return_value = MagicMock(returncode=1)
        assert volume_exists("wegent_git_cache_user_123") is False

    @patch("executor_manager.executors.docker.git_cache_volume_manager.volume_exists")
    @patch("executor_manager.executors.docker.git_cache_volume_manager.subprocess.run")
    def test_create_user_volume_success(self, mock_run, mock_exists):
        """Test successful volume creation"""
        mock_exists.return_value = False
        mock_run.return_value = MagicMock(returncode=0, stdout="wegent_git_cache_user_123")

        success, error = create_user_volume(123)

        assert success is True
        assert error is None
        # Expect 3 calls: 1 for volume create, 2 for initializing metadata files
        assert mock_run.call_count == 3
        # Verify labels are included in first call (volume create)
        first_call_args = mock_run.call_args_list[0][0][0]
        assert "wegent.user-id=123" in first_call_args
        assert any("wegent.created-at=" in arg for arg in first_call_args)
        assert any("wegent.last-used=" in arg for arg in first_call_args)

    @patch("executor_manager.executors.docker.git_cache_volume_manager.volume_exists")
    @patch("executor_manager.executors.docker.git_cache_volume_manager.subprocess.run")
    def test_create_user_volume_already_exists(self, mock_run, mock_exists):
        """Test volume creation when volume already exists"""
        mock_exists.return_value = True

        success, error = create_user_volume(123)

        assert success is True
        assert error is None
        mock_run.assert_not_called()

    @patch("executor_manager.executors.docker.git_cache_volume_manager.volume_exists")
    @patch("executor_manager.executors.docker.git_cache_volume_manager.subprocess.run")
    def test_create_user_volume_failure(self, mock_run, mock_exists):
        """Test volume creation failure"""
        mock_exists.return_value = False
        mock_run.side_effect = subprocess.CalledProcessError(1, "cmd", stderr="Error creating volume")

        success, error = create_user_volume(123)

        assert success is False
        assert "Error creating volume" in error

    @patch("executor_manager.executors.docker.git_cache_volume_manager.subprocess.run")
    def test_get_volume_metadata_success(self, mock_run):
        """Test getting volume metadata successfully"""
        mock_run.return_value = MagicMock(
            returncode=0,
            stdout='[{"Labels": {"wegent.user-id": "123", "wegent.created-at": "2025-01-03T10:00:00"}}]',
        )

        metadata = get_volume_metadata("wegent_git_cache_user_123")

        assert metadata is not None
        assert metadata.get("wegent.user-id") == "123"
        assert metadata.get("wegent.created-at") == "2025-01-03T10:00:00"

    @patch("executor_manager.executors.docker.git_cache_volume_manager.subprocess.run")
    def test_get_volume_metadata_not_found(self, mock_run):
        """Test getting metadata when volume doesn't exist"""
        mock_run.side_effect = subprocess.CalledProcessError(1, "cmd")

        metadata = get_volume_metadata("wegent_git_cache_user_123")

        assert metadata is None

    @patch("executor_manager.executors.docker.git_cache_volume_manager._write_last_used_to_volume")
    def test_update_volume_last_used_success(self, mock_write):
        """Test updating volume last-used timestamp via touch file"""
        mock_write.return_value = True

        result = update_volume_last_used("wegent_git_cache_user_123")

        assert result is True
        mock_write.assert_called_once()
        # Verify the timestamp format
        call_args = mock_write.call_args[0]
        assert call_args[0] == "wegent_git_cache_user_123"
        assert len(call_args[1]) > 0  # timestamp should not be empty

    @patch("executor_manager.executors.docker.git_cache_volume_manager._write_last_used_to_volume")
    def test_update_volume_last_used_failure(self, mock_write):
        """Test updating volume last-used when write fails"""
        mock_write.return_value = False

        result = update_volume_last_used("wegent_git_cache_user_123")

        assert result is False
        mock_write.assert_called_once()

    @patch("executor_manager.executors.docker.git_cache_volume_manager.subprocess.run")
    def test_delete_volume_success(self, mock_run):
        """Test successful volume deletion"""
        mock_run.return_value = MagicMock(returncode=0)

        success, error = delete_volume("wegent_git_cache_user_123")

        assert success is True
        assert error is None

    @patch("executor_manager.executors.docker.git_cache_volume_manager.subprocess.run")
    def test_delete_volume_failure(self, mock_run):
        """Test volume deletion failure"""
        mock_run.side_effect = subprocess.CalledProcessError(1, "cmd", stderr="Error deleting volume")

        success, error = delete_volume("wegent_git_cache_user_123")

        assert success is False
        assert "Error deleting volume" in error

    @patch("executor_manager.executors.docker.git_cache_volume_manager._read_volume_files")
    @patch("executor_manager.executors.docker.git_cache_volume_manager.subprocess.run")
    def test_list_user_volumes(self, mock_run, mock_read_files):
        """Test listing user volumes from touch files"""
        mock_run.return_value = MagicMock(returncode=0, stdout="wegent_git_cache_user_123\nwegent_git_cache_user_456\nother_volume\n")
        mock_read_files.side_effect = [
            {"user_id": "123", "created_at": "2025-01-03T10:00:00", "last_used": "2025-01-03T15:30:00"},
            {"user_id": "456", "created_at": "2025-01-02T10:00:00", "last_used": "2025-01-02T15:30:00"},
            None,
        ]

        volumes = list_user_volumes()

        assert len(volumes) == 2
        assert 123 in volumes
        assert 456 in volumes
        assert volumes[123]["volume_name"] == "wegent_git_cache_user_123"
        assert volumes[456]["volume_name"] == "wegent_git_cache_user_456"

    @patch("executor_manager.executors.docker.git_cache_volume_manager.subprocess.run")
    def test_get_volume_size_success(self, mock_run):
        """Test getting volume size successfully"""
        mock_run.return_value = MagicMock(returncode=0, stdout="12345678\t/data")

        size = get_volume_size("wegent_git_cache_user_123")

        assert size == 12345678

    @patch("executor_manager.executors.docker.git_cache_volume_manager.subprocess.run")
    def test_get_volume_size_failure(self, mock_run):
        """Test getting volume size when it fails"""
        mock_run.side_effect = subprocess.CalledProcessError(1, "cmd")

        size = get_volume_size("wegent_git_cache_user_123")

        assert size is None

    @patch("executor_manager.executors.docker.git_cache_volume_manager.subprocess.run")
    def test_get_all_user_volume_names(self, mock_run):
        """Test getting all user volume names"""
        mock_run.return_value = MagicMock(returncode=0, stdout="wegent_git_cache_user_123\nwegent_git_cache_user_456\nother_volume\n")

        names = get_all_user_volume_names()

        assert len(names) == 2
        assert "wegent_git_cache_user_123" in names
        assert "wegent_git_cache_user_456" in names
        assert "other_volume" not in names

    @patch("executor_manager.executors.docker.git_cache_volume_manager.subprocess.run")
    def test_get_all_user_volume_names_empty(self, mock_run):
        """Test getting all user volume names when none exist"""
        mock_run.return_value = MagicMock(returncode=0, stdout="other_volume\nanother_volume\n")

        names = get_all_user_volume_names()

        assert len(names) == 0


class TestTouchFileOperations:
    """Test cases for touch file operations"""

    @patch("executor_manager.executors.docker.git_cache_volume_manager.subprocess.run")
    def test_read_last_used_from_volume_success(self, mock_run):
        """Test reading .last_used file from volume"""
        mock_run.return_value = MagicMock(returncode=0, stdout="2025-01-03T15:30:45.123456")

        result = _read_last_used_from_volume("wegent_git_cache_user_123")

        assert result == "2025-01-03T15:30:45.123456"

    @patch("executor_manager.executors.docker.git_cache_volume_manager.subprocess.run")
    def test_read_last_used_from_volume_not_found(self, mock_run):
        """Test reading .last_used when file doesn't exist"""
        mock_run.side_effect = subprocess.CalledProcessError(1, "cmd")

        result = _read_last_used_from_volume("wegent_git_cache_user_123")

        assert result is None

    @patch("executor_manager.executors.docker.git_cache_volume_manager.subprocess.run")
    def test_read_last_used_from_volume_invalid_format(self, mock_run):
        """Test reading .last_used with invalid timestamp format"""
        mock_run.return_value = MagicMock(returncode=0, stdout="invalid-timestamp")

        result = _read_last_used_from_volume("wegent_git_cache_user_123")

        assert result is None

    @patch("executor_manager.executors.docker.git_cache_volume_manager.subprocess.run")
    def test_read_metadata_from_volume_success(self, mock_run):
        """Test reading .metadata file from volume"""
        metadata_json = '{"user_id": 123, "created_at": "2025-01-03T10:00:00", "volume_name": "wegent_git_cache_user_123"}'
        mock_run.return_value = MagicMock(returncode=0, stdout=metadata_json)

        result = _read_metadata_from_volume("wegent_git_cache_user_123")

        assert result is not None
        assert result["user_id"] == 123
        assert result["created_at"] == "2025-01-03T10:00:00"

    @patch("executor_manager.executors.docker.git_cache_volume_manager.subprocess.run")
    def test_read_metadata_from_volume_not_found(self, mock_run):
        """Test reading .metadata when file doesn't exist"""
        mock_run.side_effect = subprocess.CalledProcessError(1, "cmd")

        result = _read_metadata_from_volume("wegent_git_cache_user_123")

        assert result is None

    @patch("executor_manager.executors.docker.git_cache_volume_manager.subprocess.run")
    def test_write_last_used_to_volume_success(self, mock_run):
        """Test writing timestamp to .last_used file"""
        mock_run.return_value = MagicMock(returncode=0)

        result = _write_last_used_to_volume("wegent_git_cache_user_123", "2025-01-03T15:30:45")

        assert result is True
        mock_run.assert_called_once()
        # Verify the docker run command
        call_args = mock_run.call_args[0][0]
        assert "docker" in call_args
        assert "run" in call_args
        assert "--rm" in call_args
        assert "wegent_git_cache_user_123:/cache:rw" in call_args
        assert "echo" in " ".join(call_args)
        assert ".last_used" in " ".join(call_args)

    @patch("executor_manager.executors.docker.git_cache_volume_manager.subprocess.run")
    def test_write_last_used_to_volume_failure(self, mock_run):
        """Test writing .last_used when docker fails"""
        mock_run.return_value = MagicMock(returncode=1, stderr="volume not found")

        result = _write_last_used_to_volume("nonexistent_volume", "2025-01-03T15:30:45")

        assert result is False

    @patch("executor_manager.executors.docker.git_cache_volume_manager.subprocess.run")
    def test_write_metadata_to_volume_success(self, mock_run):
        """Test writing .metadata file to volume"""
        mock_run.return_value = MagicMock(returncode=0)

        result = _write_metadata_to_volume("wegent_git_cache_user_123", 123, "2025-01-03T10:00:00")

        assert result is True

    @patch("executor_manager.executors.docker.git_cache_volume_manager._write_last_used_to_volume")
    @patch("executor_manager.executors.docker.git_cache_volume_manager._write_metadata_to_volume")
    def test_initialize_volume_metadata_success(self, mock_write_meta, mock_write_last):
        """Test initializing both metadata files"""
        mock_write_last.return_value = True
        mock_write_meta.return_value = True

        result = _initialize_volume_metadata("wegent_git_cache_user_123", 123, "2025-01-03T10:00:00")

        assert result is True
        mock_write_last.assert_called_once()
        mock_write_meta.assert_called_once()

    @patch("executor_manager.executors.docker.git_cache_volume_manager._write_last_used_to_volume")
    @patch("executor_manager.executors.docker.git_cache_volume_manager._write_metadata_to_volume")
    def test_initialize_volume_metadata_failure(self, mock_write_meta, mock_write_last):
        """Test initializing metadata when write fails"""
        mock_write_last.return_value = False

        result = _initialize_volume_metadata("wegent_git_cache_user_123", 123, "2025-01-03T10:00:00")

        assert result is False

    @patch("executor_manager.executors.docker.git_cache_volume_manager._read_metadata_from_volume")
    @patch("executor_manager.executors.docker.git_cache_volume_manager._read_last_used_from_volume")
    def test_read_volume_files_success(self, mock_read_last, mock_read_meta):
        """Test reading both metadata files from volume"""
        mock_read_meta.return_value = {
            "user_id": 123,
            "created_at": "2025-01-03T10:00:00",
            "volume_name": "wegent_git_cache_user_123",
        }
        mock_read_last.return_value = "2025-01-03T15:30:45"

        result = _read_volume_files("wegent_git_cache_user_123")

        assert result is not None
        assert result["user_id"] == 123
        assert result["created_at"] == "2025-01-03T10:00:00"
        assert result["last_used"] == "2025-01-03T15:30:45"

    @patch("executor_manager.executors.docker.git_cache_volume_manager._read_metadata_from_volume")
    @patch("executor_manager.executors.docker.git_cache_volume_manager._read_last_used_from_volume")
    def test_read_volume_files_no_last_used(self, mock_read_last, mock_read_meta):
        """Test reading volume when .last_used doesn't exist (uses created_at as fallback)"""
        mock_read_meta.return_value = {
            "user_id": 123,
            "created_at": "2025-01-03T10:00:00",
            "volume_name": "wegent_git_cache_user_123",
        }
        mock_read_last.return_value = None

        result = _read_volume_files("wegent_git_cache_user_123")

        assert result is not None
        assert result["last_used"] == "2025-01-03T10:00:00"  # Should fallback to created_at

    @patch("executor_manager.executors.docker.git_cache_volume_manager._read_metadata_from_volume")
    def test_read_volume_files_no_metadata(self, mock_read_meta):
        """Test reading volume when .metadata doesn't exist (returns None)"""
        mock_read_meta.return_value = None

        result = _read_volume_files("wegent_git_cache_user_123")

        assert result is None
