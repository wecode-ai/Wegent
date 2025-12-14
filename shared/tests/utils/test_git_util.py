# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import MagicMock, patch

import pytest

from shared.utils.git_util import clone_repo_with_token, is_gerrit_url


class TestGitUtil:
    """Test cases for git_util module"""

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
