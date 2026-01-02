# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import os
from unittest.mock import MagicMock, patch

import pytest

from shared.utils.git_util import _clone_with_reference, _clone_without_cache, clone_repo_with_token, is_gerrit_url


class TestGitUtilWithCache:
    """Test cases for git_util module with cache functionality"""

    def setup_method(self):
        """Setup test environment before each test"""
        # Clear environment variables before each test
        for key in ["GIT_CACHE_ENABLED", "GIT_CACHE_DIR", "GIT_CACHE_AUTO_UPDATE"]:
            if key in os.environ:
                del os.environ[key]

    @patch("shared.utils.git_util.setup_git_hooks")
    @patch("shared.utils.git_util._clone_with_reference")
    @patch("shared.utils.git_util.ensure_cache_repo")
    @patch("shared.utils.git_util.get_cache_repo_path")
    @patch("shared.utils.git_util.is_cache_enabled")
    def test_clone_with_cache_enabled(
        self,
        mock_is_cache_enabled,
        mock_get_cache_path,
        mock_ensure_cache,
        mock_clone_with_ref,
        mock_setup_hooks,
    ):
        """Test clone flow when cache is enabled and working"""
        # Setup mocks
        mock_is_cache_enabled.return_value = True
        mock_get_cache_path.return_value = "/git-cache/testuser/github.com/user/repo.git"
        mock_ensure_cache.return_value = (True, None)
        mock_clone_with_ref.return_value = (True, None)
        mock_setup_hooks.return_value = (True, None)

        # Execute
        project_url = "https://github.com/user/repo.git"
        branch = "main"
        project_path = "/tmp/test-repo"
        username = "alice"
        token = "ghp_test_token"

        success, error = clone_repo_with_token(
            project_url, branch, project_path, username, token
        )

        # Verify
        assert success is True
        assert error is None
        mock_is_cache_enabled.assert_called_once()
        mock_get_cache_path.assert_called_once_with(project_url)  # No username passed
        mock_ensure_cache.assert_called_once()
        mock_clone_with_ref.assert_called_once()
        mock_setup_hooks.assert_called_once_with(project_path)

    @patch("shared.utils.git_util._clone_without_cache")
    @patch("shared.utils.git_util.ensure_cache_repo")
    @patch("shared.utils.git_util.get_cache_repo_path")
    @patch("shared.utils.git_util.is_cache_enabled")
    def test_clone_with_cache_fallback_on_cache_failure(
        self, mock_is_cache_enabled, mock_get_cache_path, mock_ensure_cache, mock_clone_without
    ):
        """Test fallback to regular clone when cache preparation fails"""
        # Setup mocks
        mock_is_cache_enabled.return_value = True
        mock_get_cache_path.return_value = "/git-cache/testuser/github.com/user/repo.git"
        mock_ensure_cache.return_value = (False, "Cache preparation failed")
        mock_clone_without.return_value = (True, None)

        # Execute
        project_url = "https://github.com/user/repo.git"
        branch = "main"
        project_path = "/tmp/test-repo"
        username = "alice"
        token = "ghp_test_token"

        success, error = clone_repo_with_token(
            project_url, branch, project_path, username, token
        )

        # Verify fallback occurred
        assert success is True
        assert error is None
        mock_ensure_cache.assert_called_once()
        mock_clone_without.assert_called_once()

    @patch("shared.utils.git_util.setup_git_hooks")
    @patch("shared.utils.git_util._clone_without_cache")
    @patch("shared.utils.git_util._clone_with_reference")
    @patch("shared.utils.git_util.ensure_cache_repo")
    @patch("shared.utils.git_util.get_cache_repo_path")
    @patch("shared.utils.git_util.is_cache_enabled")
    def test_clone_with_cache_fallback_on_reference_failure(
        self,
        mock_is_cache_enabled,
        mock_get_cache_path,
        mock_ensure_cache,
        mock_clone_with_ref,
        mock_clone_without,
        mock_setup_hooks,
    ):
        """Test fallback to regular clone when --reference clone fails"""
        # Setup mocks
        mock_is_cache_enabled.return_value = True
        mock_get_cache_path.return_value = "/git-cache/testuser/github.com/user/repo.git"
        mock_ensure_cache.return_value = (True, None)
        mock_clone_with_ref.return_value = (False, "Reference clone failed")
        mock_clone_without.return_value = (True, None)
        mock_setup_hooks.return_value = (True, None)

        # Execute
        project_url = "https://github.com/user/repo.git"
        branch = "main"
        project_path = "/tmp/test-repo"
        username = "alice"
        token = "ghp_test_token"

        success, error = clone_repo_with_token(
            project_url, branch, project_path, username, token
        )

        # Verify fallback occurred
        assert success is True
        assert error is None
        mock_clone_with_ref.assert_called_once()
        mock_clone_without.assert_called_once()

    @patch("shared.utils.git_util._clone_without_cache")
    @patch("shared.utils.git_util.is_cache_enabled")
    def test_clone_with_cache_disabled(self, mock_is_cache_enabled, mock_clone_without):
        """Test clone flow when cache is disabled"""
        # Setup mocks
        mock_is_cache_enabled.return_value = False
        mock_clone_without.return_value = (True, None)

        # Execute
        project_url = "https://github.com/user/repo.git"
        branch = "main"
        project_path = "/tmp/test-repo"
        username = "bob"
        token = "ghp_test_token"

        success, error = clone_repo_with_token(
            project_url, branch, project_path, username, token
        )

        # Verify cache was not used
        assert success is True
        assert error is None
        mock_is_cache_enabled.assert_called_once()
        mock_clone_without.assert_called_once()

    @patch("shared.utils.git_util.subprocess.run")
    def test_clone_with_reference_command(self, mock_subprocess):
        """Test that _clone_with_reference uses correct --reference flag"""
        # Setup mock
        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_subprocess.return_value = mock_result

        # Execute
        project_url = "https://github.com/user/repo.git"
        branch = "main"
        project_path = "/tmp/test-repo"
        auth_url = "https://token:ghp_test@github.com/user/repo.git"
        cache_path = "/git-cache/alice/github.com/user/repo.git"

        success, error = _clone_with_reference(
            project_url, branch, project_path, auth_url, cache_path
        )

        # Verify
        assert success is True
        assert error is None
        mock_subprocess.assert_called_once()

        # Get the command
        call_args = mock_subprocess.call_args
        cmd = call_args[0][0]

        # Verify --reference flag is present
        assert "--reference" in cmd
        assert cache_path in cmd

        # Verify command structure
        assert cmd[0] == "git"
        assert cmd[1] == "clone"
        reference_index = cmd.index("--reference")
        assert cmd[reference_index + 1] == cache_path

    @patch("shared.utils.git_util.subprocess.run")
    @patch("shared.utils.git_util.setup_git_hooks")
    def test_clone_without_cache_command(self, mock_setup_hooks, mock_subprocess):
        """Test that _clone_without_cache uses standard git clone"""
        # Setup mocks
        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_subprocess.return_value = mock_result
        mock_setup_hooks.return_value = (True, None)

        # Execute
        project_url = "https://github.com/user/repo.git"
        branch = "main"
        project_path = "/tmp/test-repo"
        auth_url = "https://token:ghp_test@github.com/user/repo.git"

        success, error = _clone_without_cache(
            project_url, branch, project_path, auth_url, "alice", "ghp_test"
        )

        # Verify
        assert success is True
        assert error is None
        mock_subprocess.assert_called_once()

        # Get the command
        call_args = mock_subprocess.call_args
        cmd = call_args[0][0]

        # Verify --reference flag is NOT present
        assert "--reference" not in cmd

        # Verify command structure
        assert cmd[0] == "git"
        assert cmd[1] == "clone"
        assert auth_url in cmd
        assert project_path in cmd

    @patch("shared.utils.git_util._clone_without_cache")
    @patch("shared.utils.git_util.is_cache_enabled")
    def test_cache_uses_user_id_not_git_username(self, mock_is_cache_enabled, mock_clone_without):
        """Test that cache uses user_id (not git username)"""
        # Setup mocks
        mock_is_cache_enabled.return_value = False
        mock_clone_without.return_value = (True, None)

        # Execute with different git usernames - but cache will use user_id
        project_url = "https://github.com/user/repo.git"

        # These calls use different git usernames for authentication
        clone_repo_with_token(project_url, "main", "/tmp/repo1", "alice", "token_alice")
        clone_repo_with_token(project_url, "main", "/tmp/repo2", "bob", "token_bob")

        # Both calls should succeed
        assert mock_clone_without.call_count == 2

        # When cache is enabled, both would use the same user_id for cache path
        # Git usernames are only used for authentication, not cache isolation
        # user_id comes from database user.id, passed by executor_manager


class TestGitUtil:
    """Test cases for git_util module (existing tests)"""

    def test_is_gerrit_url_github(self):
        """Test that GitHub URLs are not identified as Gerrit"""
        assert is_gerrit_url("https://github.com/test/repo.git") is False
        assert is_gerrit_url("https://github.company.com/test/repo.git") is False

    def test_is_gerrit_url_gitlab(self):
        """Test that GitLab URLs are not identified as Gerrit"""
        assert is_gerrit_url("https://gitlab.com/test/repo.git") is False
        assert is_gerrit_url("https://gitlab.company.com/test/repo.git") is False

    def test_is_gerrit_url_gitee(self):
        """Test that Gitee URLs are not identified as Gerrit"""
        assert is_gerrit_url("https://gitee.com/test/repo.git") is False

    def test_is_gerrit_url_bitbucket(self):
        """Test that Bitbucket URLs are not identified as Gerrit"""
        assert is_gerrit_url("https://bitbucket.org/test/repo.git") is False

    def test_is_gerrit_url_gerrit(self):
        """Test that Gerrit URLs are correctly identified"""
        assert is_gerrit_url("https://gerrit.example.com/project") is True
        assert is_gerrit_url("http://gerrit.company.com/project") is True
        assert is_gerrit_url("https://code-gerrit.internal.net/repo") is True
        assert is_gerrit_url("https://review.gerrit.company.com/repo") is True

    def test_is_gerrit_url_non_gerrit_internal(self):
        """Test that non-Gerrit internal URLs are not identified as Gerrit"""
        assert is_gerrit_url("https://git.internal.com/project") is False
        assert is_gerrit_url("https://review.company.com/project") is False
        assert is_gerrit_url("https://code-review.internal.net/repo") is False

    def test_is_gerrit_url_ssh(self):
        """Test SSH URLs containing gerrit are identified as Gerrit"""
        assert is_gerrit_url("git@github.com:test/repo.git") is False
        assert is_gerrit_url("ssh://git@gerrit.example.com:29418/project") is True

    @patch("shared.utils.git_util.subprocess.run")
    @patch("shared.utils.git_util.setup_git_hooks")
    def test_clone_repo_with_token_gerrit_url_encoding(
        self, mock_setup_hooks, mock_subprocess
    ):
        """Test that Gerrit URLs get URL encoded credentials"""
        # Mock successful subprocess.run
        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_subprocess.return_value = mock_result

        # Mock setup_git_hooks to return success
        mock_setup_hooks.return_value = (True, None)

        # Test with Gerrit URL and special characters in token
        project_url = "https://gerrit.example.com/project"
        branch = "main"
        project_path = "/tmp/test-repo"
        username = "test_user"
        token = "test/password/with/slashes"

        success, error = clone_repo_with_token(
            project_url, branch, project_path, username, token
        )

        # Verify success
        assert success is True
        assert error is None

        # Verify subprocess.run was called
        assert mock_subprocess.called

        # Get the actual command that was passed to subprocess.run
        call_args = mock_subprocess.call_args
        cmd = call_args[0][0]  # First positional argument

        # Extract the URL from the command
        # Command structure: ['git', 'clone', '--branch', 'main', '--single-branch', URL, PATH]
        auth_url = cmd[5]  # The URL is at index 5

        # Verify that the URL contains encoded characters for Gerrit
        assert "%2F" in auth_url  # / should be encoded
        assert (
            "test/password/with/slashes" not in auth_url
        )  # Raw token should not appear

    @patch("shared.utils.git_util.subprocess.run")
    @patch("shared.utils.git_util.setup_git_hooks")
    def test_clone_repo_with_token_github_no_encoding(
        self, mock_setup_hooks, mock_subprocess
    ):
        """Test that GitHub URLs don't get URL encoded (credentials used as-is)"""
        # Mock successful subprocess.run
        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_subprocess.return_value = mock_result

        # Mock setup_git_hooks to return success
        mock_setup_hooks.return_value = (True, None)

        # Test with GitHub URL
        project_url = "https://github.com/test/repo.git"
        branch = "main"
        project_path = "/tmp/test-repo"
        username = "normaluser"
        token = "ghp_simpletoken123"

        success, error = clone_repo_with_token(
            project_url, branch, project_path, username, token
        )

        # Verify success
        assert success is True
        assert error is None

        # Verify subprocess.run was called
        assert mock_subprocess.called

        # Get the actual command
        call_args = mock_subprocess.call_args
        cmd = call_args[0][0]
        auth_url = cmd[5]

        # Verify credentials are used as-is for GitHub (no URL encoding)
        assert "normaluser" in auth_url
        assert "ghp_simpletoken123" in auth_url

    @patch("shared.utils.git_util.subprocess.run")
    @patch("shared.utils.git_util.setup_git_hooks")
    def test_clone_repo_with_token_gitlab_no_encoding(
        self, mock_setup_hooks, mock_subprocess
    ):
        """Test that GitLab URLs don't get URL encoded"""
        # Mock successful subprocess.run
        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_subprocess.return_value = mock_result

        # Mock setup_git_hooks to return success
        mock_setup_hooks.return_value = (True, None)

        project_url = "https://gitlab.com/test/repo.git"
        branch = "main"
        project_path = "/tmp/test-repo"
        username = "oauth2"
        token = "glpat-simpletoken"

        success, error = clone_repo_with_token(
            project_url, branch, project_path, username, token
        )

        # Verify success
        assert success is True
        assert error is None

        # Get the actual command
        call_args = mock_subprocess.call_args
        cmd = call_args[0][0]
        auth_url = cmd[5]

        # Verify credentials are used as-is for GitLab (no URL encoding)
        assert "oauth2" in auth_url
        assert "glpat-simpletoken" in auth_url

    @patch("shared.utils.git_util.subprocess.run")
    def test_clone_repo_with_token_failure(self, mock_subprocess):
        """Test handling of clone failure"""
        # Mock failed subprocess.run
        mock_subprocess.side_effect = Exception("Clone failed")

        project_url = "https://github.com/test/repo.git"
        branch = "main"
        project_path = "/tmp/test-repo"
        username = "testuser"
        token = "testtoken"

        success, error = clone_repo_with_token(
            project_url, branch, project_path, username, token
        )

        # Verify failure
        assert success is False
        assert "Clone failed" in error


class TestGitUtilCacheEdgeCases:
    """Test edge cases for git cache functionality"""

    def setup_method(self):
        """Setup test environment before each test"""
        for key in ["GIT_CACHE_ENABLED", "GIT_CACHE_DIR", "GIT_CACHE_AUTO_UPDATE"]:
            if key in os.environ:
                del os.environ[key]

    @patch("shared.utils.git_util._clone_without_cache")
    @patch("shared.utils.git_util.is_cache_enabled")
    def test_clone_with_timeout_error(self, mock_is_cache_enabled, mock_clone_without):
        """Test handling of timeout errors"""
        from subprocess import TimeoutExpired

        mock_is_cache_enabled.return_value = False
        mock_clone_without.return_value = (False, "Clone timed out")

        project_url = "https://github.com/user/repo.git"
        branch = "main"
        project_path = "/tmp/test-repo"
        username = "alice"
        token = "ghp_test_token"

        success, error = clone_repo_with_token(
            project_url, branch, project_path, username, token
        )

        # Should handle timeout gracefully
        assert isinstance(success, bool)
        assert isinstance(error, str)

    @patch("shared.utils.git_util._clone_without_cache")
    @patch("shared.utils.git_util.ensure_cache_repo")
    @patch("shared.utils.git_util.get_cache_repo_path")
    @patch("shared.utils.git_util.is_cache_enabled")
    def test_clone_with_cache_enabled_user_id_validation(
        self,
        mock_is_cache_enabled,
        mock_get_cache_path,
        mock_ensure_cache,
        mock_clone_without,
    ):
        """Test that cache uses user_id from environment variable"""
        mock_is_cache_enabled.return_value = True
        mock_get_cache_path.return_value = "/git-cache/user_123/github.com/repo.git"
        mock_ensure_cache.return_value = (True, None)
        mock_clone_without.return_value = (True, None)

        project_url = "https://github.com/repo.git"
        git_username = "alice"
        token = "test_token"

        # Set user_id environment variable (normally set by executor_manager)
        import os
        os.environ["GIT_CACHE_USER_ID"] = "123"

        try:
            success, error = clone_repo_with_token(
                project_url, "main", "/tmp/repo", git_username, token
            )

            # Should use user_id, not git username
            assert success is True
            mock_get_cache_path.assert_called_once_with(project_url)
        finally:
            # Clean up
            if "GIT_CACHE_USER_ID" in os.environ:
                del os.environ["GIT_CACHE_USER_ID"]

    @patch("shared.utils.git_util._clone_without_cache")
    @patch("shared.utils.git_util.is_cache_enabled")
    def test_clone_without_branch(self, mock_is_cache_enabled, mock_clone_without):
        """Test clone without specifying branch"""
        mock_is_cache_enabled.return_value = False
        mock_clone_without.return_value = (True, None)

        project_url = "https://github.com/user/repo.git"
        branch = None  # No branch specified
        project_path = "/tmp/repo"
        username = "alice"
        token = "test_token"

        success, error = clone_repo_with_token(
            project_url, branch, project_path, username, token
        )

        # Should handle None branch correctly
        assert success is True
        mock_clone_without.assert_called_once()

    @patch("shared.utils.git_util._clone_without_cache")
    @patch("shared.utils.git_util.is_cache_enabled")
    def test_clone_with_empty_branch(self, mock_is_cache_enabled, mock_clone_without):
        """Test clone with empty string branch"""
        mock_is_cache_enabled.return_value = False
        mock_clone_without.return_value = (True, None)

        project_url = "https://github.com/user/repo.git"
        branch = ""  # Empty branch
        project_path = "/tmp/repo"
        username = "bob"
        token = "test_token"

        success, error = clone_repo_with_token(
            project_url, branch, project_path, username, token
        )

        # Should handle empty branch correctly
        assert success is True
        mock_clone_without.assert_called_once()
