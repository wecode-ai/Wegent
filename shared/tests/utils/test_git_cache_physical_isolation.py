# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Security and integration tests for git cache physical isolation.
"""

import os
import pytest
from shared.utils.git_cache import (
    get_cache_repo_path,
    get_user_cache_base_dir,
    get_cache_user_id,
)


class TestPhysicalIsolationSecurity:
    """Security tests for physical isolation"""

    def setup_method(self):
        """Setup test environment"""
        os.environ["GIT_CACHE_USER_ID"] = "123"
        os.environ["GIT_CACHE_USER_BASE_DIR"] = "/git-cache"
        os.environ["GIT_CACHE_ENABLED"] = "true"

    def teardown_method(self):
        """Cleanup test environment"""
        for key in ["GIT_CACHE_USER_ID", "GIT_CACHE_USER_BASE_DIR", "GIT_CACHE_ENABLED"]:
            os.environ.pop(key, None)

    def test_path_no_user_subdirectory(self):
        """Test that cache path doesn't include user subdirectory"""
        url = "https://github.com/user/repo.git"
        path = get_cache_repo_path(url)

        # Should NOT contain user_123 subdirectory
        assert "user_123" not in path

        # Should be directly under /git-cache
        assert path == "/git-cache/github.com/user/repo.git"

    def test_base_dir_is_mount_point(self):
        """Test that base directory is just the mount point"""
        base_dir = get_user_cache_base_dir()
        assert base_dir == "/git-cache"
        assert "user_" not in base_dir

    def test_ssh_url_path_generation(self):
        """Test path generation for SSH URLs"""
        url = "git@gitlab.com:group/project.git"
        path = get_cache_repo_path(url)

        assert path == "/git-cache/gitlab.com/group/project.git"
        assert "user_123" not in path

    def test_github_url_path_generation(self):
        """Test path generation for GitHub URLs"""
        url = "https://github.com/org/repo.git"
        path = get_cache_repo_path(url)

        assert path == "/git-cache/github.com/org/repo.git"
        assert "user_123" not in path

    def test_path_traversal_prevention(self):
        """Test that path traversal is still prevented"""
        # With physical isolation, path validation is still important
        url = "https://github.com/../../../etc/passwd.git"

        with pytest.raises(ValueError, match="Security violation|outside allowed"):
            get_cache_repo_path(url)

    def test_user_id_validation(self):
        """Test user ID validation"""
        # Valid user ID
        os.environ["GIT_CACHE_USER_ID"] = "456"
        assert get_cache_user_id() == 456

        # Invalid user ID (zero)
        os.environ["GIT_CACHE_USER_ID"] = "0"
        with pytest.raises(ValueError, match="Invalid user_id"):
            get_cache_user_id()

        # Invalid user ID (negative)
        os.environ["GIT_CACHE_USER_ID"] = "-1"
        with pytest.raises(ValueError, match="Invalid user_id"):
            get_cache_user_id()

        # Invalid user ID (string)
        os.environ["GIT_CACHE_USER_ID"] = "abc"
        with pytest.raises(ValueError):
            get_cache_user_id()

    def test_missing_user_id_raises_error(self):
        """Test that missing user ID raises error"""
        os.environ.pop("GIT_CACHE_USER_ID", None)

        with pytest.raises(ValueError, match="GIT_CACHE_USER_ID is not set"):
            get_cache_user_id()

    def test_missing_base_dir_raises_error(self):
        """Test that missing base directory raises error"""
        os.environ.pop("GIT_CACHE_USER_BASE_DIR", None)

        with pytest.raises(ValueError, match="GIT_CACHE_USER_BASE_DIR.*required"):
            get_user_cache_base_dir()

    def test_complex_repo_paths(self):
        """Test complex repository paths"""
        test_cases = [
            ("https://github.com/org/subdir/repo.git", "/git-cache/github.com/org/subdir/repo.git"),
            ("https://gitlab.com/group/subgroup/project.git", "/git-cache/gitlab.com/group/subgroup/project.git"),
            ("git@github.com:org/deep/nested/repo.git", "/git-cache/github.com/org/deep/nested/repo.git"),
        ]

        for url, expected_path in test_cases:
            path = get_cache_repo_path(url)
            assert path == expected_path
            assert "user_123" not in path

    def test_different_users_same_repo(self):
        """Test that different users cloning same repo get same path structure"""
        url = "https://github.com/user/repo.git"

        # User 123
        os.environ["GIT_CACHE_USER_ID"] = "123"
        path_123 = get_cache_repo_path(url)

        # User 456
        os.environ["GIT_CACHE_USER_ID"] = "456"
        path_456 = get_cache_repo_path(url)

        # Paths should be identical (same structure)
        assert path_123 == path_456
        assert path_123 == "/git-cache/github.com/user/repo.git"

        # But they will be stored in different volumes
        assert "user_123" not in path_123
        assert "user_456" not in path_456

    def test_url_without_git_extension(self):
        """Test URLs without .git extension"""
        url = "https://github.com/user/repo"
        path = get_cache_repo_path(url)

        # Should add .git extension
        assert path == "/git-cache/github.com/user/repo.git"
        assert "user_123" not in path

    def test_gerrit_url_format(self):
        """Test Gerrit URL format"""
        url = "https://gerrit.example.com/project.git"
        path = get_cache_repo_path(url)

        assert path == "/git-cache/gerrit.example.com/project.git"
        assert "user_123" not in path


class TestPhysicalIsolationIntegration:
    """Integration tests for physical isolation"""

    def test_volume_name_generation(self):
        """Test volume name generation"""
        from executor_manager.executors.docker.git_cache_volume_manager import get_user_volume_name

        # Test various user IDs
        assert get_user_volume_name(1) == "wegent_git_cache_user_1"
        assert get_user_volume_name(123) == "wegent_git_cache_user_123"
        assert get_user_volume_name(999999) == "wegent_git_cache_user_999999"

    @pytest.mark.skipif(not os.getenv("RUN_DOCKER_TESTS"), reason="Docker tests not enabled")
    def test_volume_creation_and_deletion(self):
        """Test actual volume creation and deletion"""
        from executor_manager.executors.docker.git_cache_volume_manager import (
            create_user_volume,
            delete_volume,
            volume_exists,
            get_user_volume_name,
        )

        test_user_id = 9999  # Use unique test ID
        volume_name = get_user_volume_name(test_user_id)

        # Ensure volume doesn't exist
        if volume_exists(volume_name):
            success, _ = delete_volume(volume_name)
            assert success

        # Create volume
        success, error = create_user_volume(test_user_id)
        assert success is True
        assert error is None
        assert volume_exists(volume_name) is True

        # Create again (should be idempotent)
        success, error = create_user_volume(test_user_id)
        assert success is True
        assert error is None

        # Delete volume
        success, error = delete_volume(volume_name)
        assert success is True
        assert error is None
        assert volume_exists(volume_name) is False

    @pytest.mark.skipif(not os.getenv("RUN_DOCKER_TESTS"), reason="Docker tests not enabled")
    def test_volume_metadata_labels(self):
        """Test volume metadata labels"""
        from executor_manager.executors.docker.git_cache_volume_manager import (
            create_user_volume,
            get_volume_metadata,
            delete_volume,
            get_user_volume_name,
        )

        test_user_id = 9998
        volume_name = get_user_volume_name(test_user_id)

        # Create volume
        success, _ = create_user_volume(test_user_id)
        assert success

        # Get metadata
        metadata = get_volume_metadata(volume_name)
        assert metadata is not None
        assert metadata.get("wegent.user-id") == str(test_user_id)
        assert "wegent.created-at" in metadata
        assert "wegent.last-used" in metadata

        # Cleanup
        delete_volume(volume_name)

    def test_cleanup_manager_configuration(self):
        """Test cleanup manager reads configuration correctly"""
        from executor_manager.git_cache_cleanup import GitCacheCleanupManager

        # Test with custom configuration
        os.environ["GIT_CACHE_CLEANUP_ENABLED"] = "true"
        os.environ["GIT_CACHE_INACTIVE_DAYS"] = "60"
        os.environ["GIT_CACHE_PROTECTED_USERS"] = "10,20,30"
        os.environ["GIT_CACHE_CLEANUP_DRY_RUN"] = "true"

        manager = GitCacheCleanupManager()

        assert manager.enabled is True
        assert manager.inactive_days == 60
        assert manager.protected_users == {10, 20, 30}
        assert manager.dry_run is True

        # Cleanup
        for key in [
            "GIT_CACHE_CLEANUP_ENABLED",
            "GIT_CACHE_INACTIVE_DAYS",
            "GIT_CACHE_PROTECTED_USERS",
            "GIT_CACHE_CLEANUP_DRY_RUN",
        ]:
            os.environ.pop(key, None)
