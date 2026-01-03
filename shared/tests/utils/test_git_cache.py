# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import os
from unittest.mock import MagicMock, patch

import pytest

from shared.utils.git_cache import (
    get_cache_repo_path,
    get_cache_user_id,
    get_user_cache_base_dir,
    is_auto_update_enabled,
    is_cache_enabled,
)


class TestGitCacheUserId:
    """Test cases for user_id handling in git_cache module"""

    def setup_method(self):
        """Setup test environment before each test"""
        # Clear environment variables before each test
        for key in [
            "GIT_CACHE_ENABLED",
            "GIT_CACHE_AUTO_UPDATE",
            "GIT_CACHE_USER_ID",
            "GIT_CACHE_USER_BASE_DIR",
        ]:
            if key in os.environ:
                del os.environ[key]

    def test_get_cache_user_id_valid(self):
        """Test getting valid user_id from environment variable"""
        os.environ["GIT_CACHE_USER_ID"] = "123"
        assert get_cache_user_id() == 123

    def test_get_cache_user_id_large_number(self):
        """Test getting large user_id"""
        os.environ["GIT_CACHE_USER_ID"] = "999999"
        assert get_cache_user_id() == 999999

    def test_get_cache_user_id_missing(self):
        """Test error when GIT_CACHE_USER_ID is not set"""
        with pytest.raises(ValueError) as exc_info:
            get_cache_user_id()

        assert "GIT_CACHE_USER_ID is not set" in str(exc_info.value)
        assert "required for git cache isolation" in str(exc_info.value)

    def test_get_cache_user_id_invalid_string(self):
        """Test error when GIT_CACHE_USER_ID is not a valid integer"""
        os.environ["GIT_CACHE_USER_ID"] = "abc"

        with pytest.raises(ValueError) as exc_info:
            get_cache_user_id()

        assert "Must be a valid integer" in str(exc_info.value)
        assert "abc" in str(exc_info.value)

    def test_get_cache_user_id_zero(self):
        """Test error when user_id is zero"""
        os.environ["GIT_CACHE_USER_ID"] = "0"

        with pytest.raises(ValueError) as exc_info:
            get_cache_user_id()

        assert "Invalid user_id: 0" in str(exc_info.value)
        assert "Must be a positive integer" in str(exc_info.value)

    def test_get_cache_user_id_negative(self):
        """Test error when user_id is negative"""
        os.environ["GIT_CACHE_USER_ID"] = "-1"

        with pytest.raises(ValueError) as exc_info:
            get_cache_user_id()

        assert "Invalid user_id: -1" in str(exc_info.value)

    def test_get_cache_user_id_float(self):
        """Test error when user_id is a float string"""
        os.environ["GIT_CACHE_USER_ID"] = "123.45"

        with pytest.raises(ValueError) as exc_info:
            get_cache_user_id()

        assert "Must be a valid integer" in str(exc_info.value)

    def test_get_cache_user_id_empty_string(self):
        """Test error when user_id is empty string"""
        os.environ["GIT_CACHE_USER_ID"] = ""

        with pytest.raises(ValueError) as exc_info:
            get_cache_user_id()

        assert "GIT_CACHE_USER_ID is not set" in str(exc_info.value)

    def test_get_cache_user_id_whitespace(self):
        """Test error when user_id is whitespace"""
        os.environ["GIT_CACHE_USER_ID"] = "   "

        with pytest.raises(ValueError) as exc_info:
            get_cache_user_id()

        assert "Must be a valid integer" in str(exc_info.value)


class TestGitCache:
    """Test cases for git_cache module core functionality"""

    def setup_method(self):
        """Setup test environment before each test"""
        # Clear environment variables before each test
        for key in [
            "GIT_CACHE_ENABLED",
            "GIT_CACHE_AUTO_UPDATE",
            "GIT_CACHE_USER_ID",
            "GIT_CACHE_USER_BASE_DIR",
        ]:
            if key in os.environ:
                del os.environ[key]

    def test_is_cache_enabled_default(self):
        """Test that cache is disabled by default"""
        assert is_cache_enabled() is False

    def test_is_cache_enabled_true(self):
        """Test that cache can be enabled via environment variable"""
        os.environ["GIT_CACHE_ENABLED"] = "true"
        assert is_cache_enabled() is True

    def test_is_cache_enabled_false(self):
        """Test that cache can be explicitly disabled"""
        os.environ["GIT_CACHE_ENABLED"] = "false"
        assert is_cache_enabled() is False

    def test_is_cache_enabled_case_insensitive(self):
        """Test that enabled flag is case insensitive"""
        os.environ["GIT_CACHE_ENABLED"] = "TRUE"
        assert is_cache_enabled() is True

        os.environ["GIT_CACHE_ENABLED"] = "True"
        assert is_cache_enabled() is True

        os.environ["GIT_CACHE_ENABLED"] = "FALSE"
        assert is_cache_enabled() is False

    def test_is_auto_update_enabled_default(self):
        """Test that auto-update is enabled by default"""
        assert is_auto_update_enabled() is True

    def test_is_auto_update_enabled_disabled(self):
        """Test that auto-update can be disabled"""
        os.environ["GIT_CACHE_AUTO_UPDATE"] = "false"
        assert is_auto_update_enabled() is False

    def test_get_cache_repo_path_github_https(self):
        """Test cache path for GitHub HTTPS URL with user_id"""
        os.environ["GIT_CACHE_USER_ID"] = "123"
        url = "https://github.com/user/repo.git"

        cache_path = get_cache_repo_path(url)

        assert cache_path == "/git-cache/user_123/github.com/user/repo.git"

    def test_get_cache_repo_path_gitlab_https(self):
        """Test cache path for GitLab HTTPS URL with user_id"""
        os.environ["GIT_CACHE_USER_ID"] = "456"
        url = "https://gitlab.com/group/project.git"

        cache_path = get_cache_repo_path(url)

        assert cache_path == "/git-cache/user_456/gitlab.com/group/project.git"

    def test_get_cache_repo_path_gerrit(self):
        """Test cache path for Gerrit URL with user_id"""
        os.environ["GIT_CACHE_USER_ID"] = "789"
        url = "https://gerrit.example.com/project"

        cache_path = get_cache_repo_path(url)

        assert cache_path == "/git-cache/user_789/gerrit.example.com/project.git"

    def test_get_cache_repo_path_ssh(self):
        """Test cache path for SSH URL with user_id"""
        os.environ["GIT_CACHE_USER_ID"] = "100"
        url = "git@github.com:user/repo.git"

        cache_path = get_cache_repo_path(url)

        assert cache_path == "/git-cache/user_100/github.com/user/repo.git"

    def test_get_cache_repo_path_without_git_suffix(self):
        """Test cache path for URL without .git suffix"""
        os.environ["GIT_CACHE_USER_ID"] = "300"
        url = "https://github.com/user/repo"

        cache_path = get_cache_repo_path(url)

        assert cache_path == "/git-cache/user_300/github.com/user/repo.git"

    def test_get_cache_repo_path_with_nested_path(self):
        """Test cache path for repository with nested path"""
        os.environ["GIT_CACHE_USER_ID"] = "400"
        url = "https://github.com/org/subgroup/project.git"

        cache_path = get_cache_repo_path(url)

        assert cache_path == "/git-cache/user_400/github.com/org/subgroup/project.git"

    def test_get_cache_repo_path_without_user_id_raises_error(self):
        """Test that get_cache_repo_path raises error without user_id"""
        url = "https://github.com/user/repo.git"

        # Clear user_id if set
        if "GIT_CACHE_USER_ID" in os.environ:
            del os.environ["GIT_CACHE_USER_ID"]

        with pytest.raises(ValueError) as exc_info:
            get_cache_repo_path(url)

        assert "GIT_CACHE_USER_ID is not set" in str(exc_info.value)

    def test_user_id_isolation(self):
        """Test that different user_ids get different cache paths"""
        url = "https://github.com/sensitive-org/repo.git"

        # User 123
        os.environ["GIT_CACHE_USER_ID"] = "123"
        cache_123 = get_cache_repo_path(url)

        # User 456
        os.environ["GIT_CACHE_USER_ID"] = "456"
        cache_456 = get_cache_repo_path(url)

        # Verify paths are completely isolated
        assert cache_123 != cache_456
        assert "user_123" in cache_123
        assert "user_456" in cache_456
        assert cache_123.startswith("/git-cache/")
        assert cache_456.startswith("/git-cache/")


class TestGitCacheSecurity:
    """Test security aspects of git_cache module"""

    def setup_method(self):
        """Setup test environment before each test"""
        for key in ["GIT_CACHE_ENABLED", "GIT_CACHE_AUTO_UPDATE", "GIT_CACHE_USER_ID"]:
            if key in os.environ:
                del os.environ[key]

    def test_user_id_isolation_security(self):
        """Test that different user_ids get different cache paths"""
        url = "https://github.com/sensitive-org/repo.git"

        # User 1 (admin)
        os.environ["GIT_CACHE_USER_ID"] = "1"
        admin_cache = get_cache_repo_path(url)

        # User 2 (regular user)
        os.environ["GIT_CACHE_USER_ID"] = "2"
        user_cache = get_cache_repo_path(url)

        # Verify paths are completely isolated
        assert admin_cache != user_cache
        assert "user_1" in admin_cache
        assert "user_2" in user_cache
        assert admin_cache.startswith("/git-cache/")
        assert user_cache.startswith("/git-cache/")

    def test_cache_path_traversal_protection(self):
        """Test that cache paths are safe from traversal attacks"""
        os.environ["GIT_CACHE_USER_ID"] = "123"
        url = "https://github.com/user/repo.git"

        cache_path = get_cache_repo_path(url)

        # Path should not contain .. or other traversal patterns
        assert ".." not in cache_path
        assert cache_path.startswith("/git-cache/")

    def test_user_id_validation_prevents_injection(self):
        """Test that user_id validation prevents code injection"""
        # Try various injection attempts
        invalid_inputs = [
            "123; DROP TABLE users;--",
            "123 OR 1=1",
            "$(rm -rf /)",
            "`whoami`",
            "123 && ls",
            "123|cat /etc/passwd",
        ]

        for malicious_input in invalid_inputs:
            os.environ["GIT_CACHE_USER_ID"] = malicious_input

            with pytest.raises(ValueError):
                get_cache_user_id()


class TestGitCacheEdgeCases:
    """Test edge cases for git_cache module"""

    def setup_method(self):
        """Setup test environment before each test"""
        for key in ["GIT_CACHE_ENABLED", "GIT_CACHE_AUTO_UPDATE", "GIT_CACHE_USER_ID"]:
            if key in os.environ:
                del os.environ[key]

    def test_get_cache_repo_path_url_with_port(self):
        """Test cache path for URL with port number"""
        os.environ["GIT_CACHE_USER_ID"] = "500"
        url = "https://git.example.com:8443/repo.git"

        cache_path = get_cache_repo_path(url)

        # Port should be included in domain
        assert "git.example.com:8443" in cache_path

    def test_get_cache_repo_path_multiple_repos_same_user(self):
        """Test that a single user can cache multiple repositories"""
        os.environ["GIT_CACHE_USER_ID"] = "600"

        repo1 = get_cache_repo_path("https://github.com/user/repo1.git")
        repo2 = get_cache_repo_path("https://github.com/user/repo2.git")
        repo3 = get_cache_repo_path("https://gitlab.com/group/project.git")

        # All should be under the same user directory
        assert "/user_600/" in repo1
        assert "/user_600/" in repo2
        assert "/user_600/" in repo3

        # But point to different repositories
        assert repo1 != repo2
        assert repo2 != repo3
        assert repo1 != repo3

        # Verify full paths
        assert repo1 == "/git-cache/user_600/github.com/user/repo1.git"
        assert repo2 == "/git-cache/user_600/github.com/user/repo2.git"
        assert repo3 == "/git-cache/user_600/gitlab.com/group/project.git"

    def test_large_user_id(self):
        """Test cache path with very large user_id"""
        os.environ["GIT_CACHE_USER_ID"] = "2147483647"  # Max int32
        url = "https://github.com/user/repo.git"

        cache_path = get_cache_repo_path(url)

        assert "user_2147483647" in cache_path
        assert cache_path.startswith("/git-cache/")

    def test_minimal_user_id(self):
        """Test cache path with minimal user_id (1)"""
        os.environ["GIT_CACHE_USER_ID"] = "1"
        url = "https://github.com/user/repo.git"

        cache_path = get_cache_repo_path(url)

        assert cache_path == "/git-cache/user_1/github.com/user/repo.git"


class TestGitCacheSecureIsolation:
    """Test cases for new secure user isolation feature"""

    def setup_method(self):
        """Setup test environment before each test"""
        for key in [
            "GIT_CACHE_ENABLED",
            "GIT_CACHE_AUTO_UPDATE",
            "GIT_CACHE_USER_ID",
            "GIT_CACHE_USER_BASE_DIR",
        ]:
            if key in os.environ:
                del os.environ[key]

    def test_get_user_cache_base_dir_with_env_var(self):
        """Test get_user_cache_base_dir with GIT_CACHE_USER_BASE_DIR set"""
        os.environ["GIT_CACHE_USER_ID"] = "123"
        os.environ["GIT_CACHE_USER_BASE_DIR"] = "/git-cache/user_123"

        base_dir = get_user_cache_base_dir()

        assert base_dir == "/git-cache/user_123"

    def test_get_user_cache_base_dir_raises_error_without_env_var(self):
        """Test get_user_cache_base_dir raises error without GIT_CACHE_USER_BASE_DIR"""
        os.environ["GIT_CACHE_USER_ID"] = "456"
        # Don't set GIT_CACHE_USER_BASE_DIR

        with pytest.raises(ValueError) as exc_info:
            get_user_cache_base_dir()

        assert "GIT_CACHE_USER_BASE_DIR environment variable is required" in str(exc_info.value)

    def test_cache_repo_path_with_user_base_dir(self):
        """Test cache repo path respects GIT_CACHE_USER_BASE_DIR"""
        os.environ["GIT_CACHE_USER_ID"] = "100"
        os.environ["GIT_CACHE_USER_BASE_DIR"] = "/git-cache/user_100"
        url = "https://github.com/user/repo.git"

        cache_path = get_cache_repo_path(url)

        # Should use GIT_CACHE_USER_BASE_DIR
        assert cache_path == "/git-cache/user_100/github.com/user/repo.git"

    def test_secure_isolation_different_users(self):
        """Test that secure design properly isolates different users"""
        url = "https://github.com/sensitive-org/private-repo.git"

        # User 123 - sees only /git-cache/user_123
        os.environ["GIT_CACHE_USER_ID"] = "123"
        os.environ["GIT_CACHE_USER_BASE_DIR"] = "/git-cache/user_123"
        cache_123 = get_cache_repo_path(url)

        # User 456 - sees only /git-cache/user_456
        os.environ["GIT_CACHE_USER_ID"] = "456"
        os.environ["GIT_CACHE_USER_BASE_DIR"] = "/git-cache/user_456"
        cache_456 = get_cache_repo_path(url)

        # Verify complete isolation
        assert cache_123 == "/git-cache/user_123/github.com/sensitive-org/private-repo.git"
        assert cache_456 == "/git-cache/user_456/github.com/sensitive-org/private-repo.git"
        assert cache_123 != cache_456

        # User 123 cannot access user 456's cache
        assert "/user_456/" not in cache_123
        # User 456 cannot access user 123's cache
        assert "/user_123/" not in cache_456


class TestGitCachePathValidation:
    """Test cases for cache path validation"""

    def setup_method(self):
        """Setup test environment before each test"""
        for key in [
            "GIT_CACHE_ENABLED",
            "GIT_CACHE_AUTO_UPDATE",
            "GIT_CACHE_USER_ID",
            "GIT_CACHE_USER_BASE_DIR",
        ]:
            if key in os.environ:
                del os.environ[key]

    def test_cache_path_within_allowed_directory(self):
        """Test that cache paths are validated correctly"""
        from shared.utils.git_cache import _validate_cache_path

        os.environ["GIT_CACHE_USER_ID"] = "123"
        os.environ["GIT_CACHE_USER_BASE_DIR"] = "/git-cache/user_123"

        allowed_base = "/git-cache/user_123"
        valid_path = "/git-cache/user_123/github.com/repo.git"

        # Should not raise
        result = _validate_cache_path(valid_path, allowed_base)
        assert result is True

    def test_cache_path_outside_allowed_directory_raises_error(self):
        """Test that paths outside allowed directory raise ValueError"""
        from shared.utils.git_cache import _validate_cache_path

        allowed_base = "/git-cache/user_123"
        malicious_path = "/git-cache/user_456/github.com/repo.git"

        with pytest.raises(ValueError) as exc_info:
            _validate_cache_path(malicious_path, allowed_base)

        assert "Security violation" in str(exc_info.value)
        assert "outside allowed base directory" in str(exc_info.value)

    def test_cache_path_traversal_attack_prevented(self):
        """Test that path traversal attacks are prevented"""
        from shared.utils.git_cache import _validate_cache_path

        allowed_base = "/git-cache/user_123"
        traversal_path = "/git-cache/user_123/../user_456/repo.git"

        with pytest.raises(ValueError) as exc_info:
            _validate_cache_path(traversal_path, allowed_base)

        assert "Security violation" in str(exc_info.value)

    def test_cache_path_absolute_validation(self):
        """Test that both relative and absolute paths are handled correctly"""
        from shared.utils.git_cache import _validate_cache_path

        os.environ["GIT_CACHE_USER_ID"] = "123"

        allowed_base = "/git-cache/user_123"
        valid_path = "/git-cache/user_123/github.com/repo.git"

        # Should not raise
        result = _validate_cache_path(valid_path, allowed_base)
        assert result is True
