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
        mock_run.assert_called_once()
        # Verify labels are included
        call_args = mock_run.call_args[0][0]
        assert "wegent.user-id=123" in call_args
        assert "wegent.created-at=" in call_args
        assert "wegent.last-used=" in call_args

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

    @patch("executor_manager.executors.docker.git_cache_volume_manager.get_volume_metadata")
    @patch("executor_manager.executors.docker.git_cache_volume_manager.subprocess.run")
    def test_update_volume_last_used_success(self, mock_run, mock_metadata):
        """Test updating volume last-used timestamp"""
        mock_metadata.return_value = {"wegent.user-id": "123", "wegent.created-at": "2025-01-03T10:00:00", "wegent.last-used": "2025-01-03T10:00:00"}
        mock_run.return_value = MagicMock(returncode=0)

        result = update_volume_last_used("wegent_git_cache_user_123")

        assert result is True
        mock_run.assert_called_once()

    @patch("executor_manager.executors.docker.git_cache_volume_manager.get_volume_metadata")
    def test_update_volume_last_used_not_found(self, mock_metadata):
        """Test updating metadata when volume doesn't exist"""
        mock_metadata.return_value = None

        result = update_volume_last_used("wegent_git_cache_user_123")

        assert result is False

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

    @patch("executor_manager.executors.docker.git_cache_volume_manager.get_volume_metadata")
    @patch("executor_manager.executors.docker.git_cache_volume_manager.subprocess.run")
    def test_list_user_volumes(self, mock_run, mock_metadata):
        """Test listing user volumes"""
        mock_run.return_value = MagicMock(returncode=0, stdout="wegent_git_cache_user_123\nwegent_git_cache_user_456\nother_volume\n")
        mock_metadata.side_effect = [
            {"wegent.user-id": "123", "wegent.created-at": "2025-01-03T10:00:00", "wegent.last-used": "2025-01-03T15:30:00"},
            {"wegent.user-id": "456", "wegent.created-at": "2025-01-02T10:00:00", "wegent.last-used": "2025-01-02T15:30:00"},
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
