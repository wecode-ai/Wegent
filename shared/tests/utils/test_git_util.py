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

    @patch("shared.utils.git_util.subprocess.run")
    @patch("shared.utils.git_util.setup_git_hooks")
    def test_clone_repo_with_token_gerrit_at_symbol(
        self, mock_setup_hooks, mock_subprocess
    ):
        """Test that Gerrit tokens with @ symbol are properly URL encoded"""
        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_subprocess.return_value = mock_result
        mock_setup_hooks.return_value = (True, None)

        project_url = "https://gerrit.example.com/project"
        branch = "main"
        project_path = "/tmp/test-repo"
        username = "user@domain.com"
        token = "token@with@at"

        success, error = clone_repo_with_token(
            project_url, branch, project_path, username, token
        )

        assert success is True
        assert error is None

        call_args = mock_subprocess.call_args
        cmd = call_args[0][0]
        auth_url = cmd[5]

        # @ symbol should be encoded as %40
        assert "%40" in auth_url
        assert "user@domain.com" not in auth_url
        assert "token@with@at" not in auth_url

    @patch("shared.utils.git_util.subprocess.run")
    @patch("shared.utils.git_util.setup_git_hooks")
    def test_clone_repo_with_token_gerrit_percent_symbol(
        self, mock_setup_hooks, mock_subprocess
    ):
        """Test that Gerrit tokens with % symbol are properly URL encoded"""
        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_subprocess.return_value = mock_result
        mock_setup_hooks.return_value = (True, None)

        project_url = "https://gerrit.example.com/project"
        branch = "main"
        project_path = "/tmp/test-repo"
        username = "testuser"
        token = "token%with%percent"

        success, error = clone_repo_with_token(
            project_url, branch, project_path, username, token
        )

        assert success is True
        assert error is None

        call_args = mock_subprocess.call_args
        cmd = call_args[0][0]
        auth_url = cmd[5]

        # % symbol should be encoded as %25
        assert "%25" in auth_url
        assert "token%with%percent" not in auth_url

    @patch("shared.utils.git_util.subprocess.run")
    @patch("shared.utils.git_util.setup_git_hooks")
    def test_clone_repo_with_token_gerrit_colon_symbol(
        self, mock_setup_hooks, mock_subprocess
    ):
        """Test that Gerrit tokens with : symbol are properly URL encoded"""
        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_subprocess.return_value = mock_result
        mock_setup_hooks.return_value = (True, None)

        project_url = "https://gerrit.example.com/project"
        branch = "main"
        project_path = "/tmp/test-repo"
        username = "testuser"
        token = "token:with:colon"

        success, error = clone_repo_with_token(
            project_url, branch, project_path, username, token
        )

        assert success is True
        assert error is None

        call_args = mock_subprocess.call_args
        cmd = call_args[0][0]
        auth_url = cmd[5]

        # : symbol should be encoded as %3A
        assert "%3A" in auth_url
        assert "token:with:colon" not in auth_url

    @patch("shared.utils.git_util.subprocess.run")
    @patch("shared.utils.git_util.setup_git_hooks")
    def test_clone_repo_with_token_gerrit_mixed_special_chars(
        self, mock_setup_hooks, mock_subprocess
    ):
        """Test that Gerrit tokens with mixed special characters are properly URL encoded"""
        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_subprocess.return_value = mock_result
        mock_setup_hooks.return_value = (True, None)

        project_url = "https://gerrit.example.com/project"
        branch = "main"
        project_path = "/tmp/test-repo"
        username = "user@company"
        # Token with multiple special characters: / @ % : + = & ? #
        token = "abc/def@ghi%jkl:mno+pqr=stu&vwx?yz#123"

        success, error = clone_repo_with_token(
            project_url, branch, project_path, username, token
        )

        assert success is True
        assert error is None

        call_args = mock_subprocess.call_args
        cmd = call_args[0][0]
        auth_url = cmd[5]

        # All special characters should be encoded
        assert "%2F" in auth_url  # / -> %2F
        assert "%40" in auth_url  # @ -> %40
        assert "%25" in auth_url  # % -> %25
        assert "%3A" in auth_url  # : -> %3A
        assert "%2B" in auth_url  # + -> %2B
        assert "%3D" in auth_url  # = -> %3D
        assert "%26" in auth_url  # & -> %26
        assert "%3F" in auth_url  # ? -> %3F
        assert "%23" in auth_url  # # -> %23

        # Raw special characters should not appear in the URL
        assert "abc/def" not in auth_url
        assert "@ghi" not in auth_url

    @patch("shared.utils.git_util.subprocess.run")
    @patch("shared.utils.git_util.setup_git_hooks")
    def test_clone_repo_with_token_gerrit_no_branch(
        self, mock_setup_hooks, mock_subprocess
    ):
        """Test Gerrit URL encoding when no branch is specified"""
        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_subprocess.return_value = mock_result
        mock_setup_hooks.return_value = (True, None)

        project_url = "https://gerrit.example.com/project"
        branch = None  # No branch specified
        project_path = "/tmp/test-repo"
        username = "testuser"
        token = "token/with/slash"

        success, error = clone_repo_with_token(
            project_url, branch, project_path, username, token
        )

        assert success is True
        assert error is None

        call_args = mock_subprocess.call_args
        cmd = call_args[0][0]

        # When no branch, command is: ['git', 'clone', URL, PATH]
        auth_url = cmd[2]

        # / should be encoded
        assert "%2F" in auth_url
        assert "token/with/slash" not in auth_url

    @patch("shared.utils.git_util.subprocess.run")
    @patch("shared.utils.git_util.setup_git_hooks")
    def test_clone_repo_with_token_gerrit_http_protocol(
        self, mock_setup_hooks, mock_subprocess
    ):
        """Test Gerrit URL encoding with HTTP protocol (not HTTPS)"""
        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_subprocess.return_value = mock_result
        mock_setup_hooks.return_value = (True, None)

        project_url = "http://gerrit.example.com/project"
        branch = "main"
        project_path = "/tmp/test-repo"
        username = "testuser"
        token = "token@special"

        success, error = clone_repo_with_token(
            project_url, branch, project_path, username, token
        )

        assert success is True
        assert error is None

        call_args = mock_subprocess.call_args
        cmd = call_args[0][0]
        auth_url = cmd[5]

        # Should start with http://
        assert auth_url.startswith("http://")
        # @ should be encoded
        assert "%40" in auth_url
        assert "token@special" not in auth_url

    @patch("shared.utils.git_util.subprocess.run")
    @patch("shared.utils.git_util.setup_git_hooks")
    def test_clone_repo_with_token_gerrit_username_with_slashes(
        self, mock_setup_hooks, mock_subprocess
    ):
        """Test that Gerrit usernames with multiple / characters are properly URL encoded"""
        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_subprocess.return_value = mock_result
        mock_setup_hooks.return_value = (True, None)

        project_url = "https://gerrit.example.com/project"
        branch = "main"
        project_path = "/tmp/test-repo"
        # Username with multiple slashes like: domain/subdomain/user
        username = "corp/team/user123"
        token = "http/token/test"

        success, error = clone_repo_with_token(
            project_url, branch, project_path, username, token
        )

        assert success is True
        assert error is None

        call_args = mock_subprocess.call_args
        cmd = call_args[0][0]
        auth_url = cmd[5]

        # All / in username and token should be encoded as %2F
        # Count occurrences: username has 2 slashes, token has 2 slashes = 4 total
        assert auth_url.count("%2F") >= 4

        # Raw username and token with slashes should not appear
        assert "corp/team/user123" not in auth_url
        assert "http/token/test" not in auth_url

        # Verify the URL structure is correct (protocol://encoded_user:encoded_token@host/path)
        assert auth_url.startswith("https://")
        assert "@gerrit.example.com" in auth_url
