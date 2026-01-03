# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest
from unittest.mock import patch, MagicMock
from datetime import datetime, timedelta
from executor_manager.git_cache_cleanup import GitCacheCleanupManager


class TestGitCacheCleanupManager:
    """Test cases for git cache cleanup manager"""

    @patch.dict("os.environ", {"GIT_CACHE_CLEANUP_ENABLED": "true", "GIT_CACHE_INACTIVE_DAYS": "30", "GIT_CACHE_PROTECTED_USERS": "1,2,3"})
    def test_initialization(self):
        """Test cleanup manager initialization"""
        manager = GitCacheCleanupManager()

        assert manager.enabled is True
        assert manager.inactive_days == 30
        assert manager.protected_users == {1, 2, 3}

    @patch.dict("os.environ", {"GIT_CACHE_CLEANUP_ENABLED": "false"})
    def test_cleanup_disabled(self):
        """Test cleanup when disabled"""
        manager = GitCacheCleanupManager()

        result = manager.cleanup_inactive_volumes()

        assert result["deleted_volumes"] == []
        assert result["total_freed_space"] == 0
        assert result["protected_volumes"] == []
        assert result["errors"] == []

    @patch("executor_manager.executors.docker.git_cache_volume_manager.list_user_volumes")
    @patch("executor_manager.executors.docker.git_cache_volume_manager.delete_volume")
    @patch("executor_manager.executors.docker.git_cache_volume_manager.get_volume_size")
    def test_cleanup_inactive_volumes(self, mock_size, mock_delete, mock_list):
        """Test cleanup of inactive volumes"""
        # Mock data
        mock_list.return_value = {
            123: {
                "volume_name": "wegent_git_cache_user_123",
                "last_used": (datetime.utcnow() - timedelta(days=40)).isoformat(),
            },
            456: {
                "volume_name": "wegent_git_cache_user_456",
                "last_used": (datetime.utcnow() - timedelta(days=10)).isoformat(),
            },
        }
        mock_size.return_value = 1024 * 1024 * 100  # 100 MB
        mock_delete.return_value = (True, None)

        manager = GitCacheCleanupManager()
        manager.enabled = True
        manager.inactive_days = 30

        result = manager.cleanup_inactive_volumes()

        assert len(result["deleted_volumes"]) == 1
        assert "wegent_git_cache_user_123" in result["deleted_volumes"]
        assert result["total_freed_space"] == 1024 * 1024 * 100

    @patch("executor_manager.executors.docker.git_cache_volume_manager.list_user_volumes")
    @patch("executor_manager.executors.docker.git_cache_volume_manager.delete_volume")
    @patch("executor_manager.executors.docker.git_cache_volume_manager.get_volume_size")
    def test_cleanup_respects_protected_users(self, mock_size, mock_delete, mock_list):
        """Test that protected users are not cleaned up"""
        # Mock data
        mock_list.return_value = {
            1: {
                "volume_name": "wegent_git_cache_user_1",
                "last_used": (datetime.utcnow() - timedelta(days=40)).isoformat(),
            },
            123: {
                "volume_name": "wegent_git_cache_user_123",
                "last_used": (datetime.utcnow() - timedelta(days=40)).isoformat(),
            },
        }
        mock_size.return_value = 1024 * 1024 * 100  # 100 MB
        mock_delete.return_value = (True, None)

        manager = GitCacheCleanupManager()
        manager.enabled = True
        manager.inactive_days = 30
        manager.protected_users = {1, 2, 3}

        result = manager.cleanup_inactive_volumes()

        assert len(result["deleted_volumes"]) == 1
        assert "wegent_git_cache_user_123" in result["deleted_volumes"]
        assert "wegent_git_cache_user_1" not in result["deleted_volumes"]
        assert "wegent_git_cache_user_1" in result["protected_volumes"]
        assert 1 == mock_delete.call_count  # delete only called for user 123, not for protected user 1

    @patch("executor_manager.executors.docker.git_cache_volume_manager.list_user_volumes")
    @patch("executor_manager.executors.docker.git_cache_volume_manager.delete_volume")
    @patch("executor_manager.executors.docker.git_cache_volume_manager.get_volume_size")
    @patch.dict("os.environ", {"GIT_CACHE_CLEANUP_DRY_RUN": "true"})
    def test_cleanup_dry_run(self, mock_size, mock_delete, mock_list):
        """Test cleanup in dry run mode"""
        # Mock data
        mock_list.return_value = {
            123: {
                "volume_name": "wegent_git_cache_user_123",
                "last_used": (datetime.utcnow() - timedelta(days=40)).isoformat(),
            }
        }
        mock_size.return_value = 1024 * 1024 * 100  # 100 MB

        manager = GitCacheCleanupManager()
        manager.enabled = True
        manager.inactive_days = 30

        result = manager.cleanup_inactive_volumes()

        assert len(result["deleted_volumes"]) == 1
        assert result["total_freed_space"] == 1024 * 1024 * 100
        mock_delete.assert_not_called()  # Should not actually delete in dry run

    @patch("executor_manager.executors.docker.git_cache_volume_manager.list_user_volumes")
    @patch("executor_manager.executors.docker.git_cache_volume_manager.delete_volume")
    @patch("executor_manager.executors.docker.git_cache_volume_manager.get_volume_size")
    def test_cleanup_handles_errors(self, mock_size, mock_delete, mock_list):
        """Test that cleanup handles deletion errors gracefully"""
        # Mock data
        mock_list.return_value = {
            123: {
                "volume_name": "wegent_git_cache_user_123",
                "last_used": (datetime.utcnow() - timedelta(days=40)).isoformat(),
            }
        }
        mock_size.return_value = 1024 * 1024 * 100  # 100 MB
        mock_delete.return_value = (False, "Volume is in use")

        manager = GitCacheCleanupManager()
        manager.enabled = True
        manager.inactive_days = 30

        result = manager.cleanup_inactive_volumes()

        assert len(result["deleted_volumes"]) == 0
        assert len(result["errors"]) == 1
        assert "Volume is in use" in result["errors"][0]

    @patch("executor_manager.executors.docker.git_cache_volume_manager.list_user_volumes")
    @patch("executor_manager.executors.docker.git_cache_volume_manager.get_volume_size")
    def test_get_volume_stats(self, mock_size, mock_list):
        """Test getting volume statistics"""
        # Mock data
        mock_list.return_value = {
            123: {
                "volume_name": "wegent_git_cache_user_123",
                "last_used": (datetime.utcnow() - timedelta(days=40)).isoformat(),
            },
            456: {
                "volume_name": "wegent_git_cache_user_456",
                "last_used": (datetime.utcnow() - timedelta(days=10)).isoformat(),
            },
        }
        mock_size.side_effect = [1024 * 1024 * 100, 1024 * 1024 * 200]  # 100 MB, 200 MB

        manager = GitCacheCleanupManager()
        manager.enabled = True
        manager.inactive_days = 30

        stats = manager.get_volume_stats()

        assert stats["total_volumes"] == 2
        assert stats["total_size_bytes"] == 1024 * 1024 * 300
        assert stats["total_size_mb"] == 300.0
        assert stats["inactive_volumes"] == 1
        assert stats["inactive_threshold_days"] == 30

    @patch.dict("os.environ", {"GIT_CACHE_PROTECTED_USERS": "1,2,invalid,4"})
    def test_load_protected_users_invalid_format(self):
        """Test loading protected users with invalid format"""
        manager = GitCacheCleanupManager()

        # When there's an invalid value in the list, the entire list is skipped
        # This is because the ValueError from int() conversion causes the entire
        # list to be rejected in the _load_protected_users method
        assert manager.protected_users == set()

    @patch("executor_manager.executors.docker.git_cache_volume_manager.list_user_volumes")
    @patch("executor_manager.executors.docker.git_cache_volume_manager.delete_volume")
    @patch("executor_manager.executors.docker.git_cache_volume_manager.get_volume_size")
    def test_cleanup_handles_missing_dates(self, mock_size, mock_delete, mock_list):
        """Test cleanup handles volumes with missing date labels"""
        # Mock data
        mock_list.return_value = {
            123: {
                "volume_name": "wegent_git_cache_user_123",
                "created_at": (datetime.utcnow() - timedelta(days=40)).isoformat(),
                "last_used": "",  # Empty last_used
            },
            456: {
                "volume_name": "wegent_git_cache_user_456",
                "created_at": "",
                "last_used": "",  # Both empty
            },
        }
        mock_size.return_value = 1024 * 1024 * 100  # 100 MB
        mock_delete.return_value = (True, None)

        manager = GitCacheCleanupManager()
        manager.enabled = True
        manager.inactive_days = 30

        result = manager.cleanup_inactive_volumes()

        # Should use created_at when last_used is missing
        assert len(result["deleted_volumes"]) == 1
        assert "wegent_git_cache_user_123" in result["deleted_volumes"]

    @patch("executor_manager.executors.docker.git_cache_volume_manager.list_user_volumes")
    @patch("executor_manager.executors.docker.git_cache_volume_manager.delete_volume")
    @patch("executor_manager.executors.docker.git_cache_volume_manager.get_volume_size")
    def test_cleanup_handles_invalid_dates(self, mock_size, mock_delete, mock_list):
        """Test cleanup handles volumes with invalid date formats"""
        # Mock data
        mock_list.return_value = {
            123: {
                "volume_name": "wegent_git_cache_user_123",
                "last_used": "invalid-date-format",
            }
        }

        manager = GitCacheCleanupManager()
        manager.enabled = True
        manager.inactive_days = 30

        result = manager.cleanup_inactive_volumes()

        # Should skip volumes with invalid dates
        assert len(result["deleted_volumes"]) == 0
        mock_delete.assert_not_called()
