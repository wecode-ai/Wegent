# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Tests for app/repository/github_provider.py
"""

import pytest
from unittest.mock import Mock, patch, MagicMock
import requests
from fastapi import HTTPException

from app.repository.github_provider import GitHubProvider
from app.models.user import User
from shared.utils.crypto import encrypt_git_token


@pytest.fixture
def github_provider():
    """Create GitHubProvider instance"""
    return GitHubProvider()


@pytest.fixture
def mock_user_with_github(test_db):
    """Create a user with GitHub configuration"""
    user = User(
        user_name="githubuser",
        email="github@test.com",
        password_hash="hashed",
        git_info=[
            {
                "type": "github",
                "git_domain": "github.com",
                "git_token": encrypt_git_token("ghp_test_token"),
                "git_id": "12345",
                "git_login": "testuser",
                "git_email": "github@test.com"
            }
        ],
        is_active=True
    )
    test_db.add(user)
    test_db.commit()
    test_db.refresh(user)
    return user


class TestGitHubProviderInit:
    """Test GitHubProvider initialization"""

    def test_provider_initialization(self, github_provider):
        """Test provider initializes with correct values"""
        assert github_provider.api_base_url == "https://api.github.com"
        assert github_provider.domain == "github.com"
        assert github_provider.type == "github"


class TestGitHubProviderValidateToken:
    """Test validate_token method"""

    def test_validate_token_success(self, github_provider):
        """Test successful token validation"""
        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "id": 12345,
            "login": "testuser",
            "name": "Test User",
            "email": "test@github.com",
            "avatar_url": "https://avatar.url"
        }

        with patch('requests.get', return_value=mock_response):
            result = github_provider.validate_token("ghp_test_token")

            assert result["valid"] is True
            assert result["user"]["id"] == 12345
            assert result["user"]["login"] == "testuser"
            assert result["user"]["email"] == "test@github.com"

    def test_validate_token_unauthorized(self, github_provider):
        """Test token validation with 401 Unauthorized"""
        mock_response = Mock()
        mock_response.status_code = 401

        with patch('requests.get', return_value=mock_response):
            result = github_provider.validate_token("invalid_token")

            assert result["valid"] is False

    def test_validate_token_empty_token(self, github_provider):
        """Test validation with empty token"""
        with pytest.raises(HTTPException) as exc_info:
            github_provider.validate_token("")

        assert exc_info.value.status_code == 400
        assert "required" in str(exc_info.value.detail).lower()

    def test_validate_token_with_custom_domain(self, github_provider):
        """Test validation with custom GitHub Enterprise domain"""
        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "id": 99999,
            "login": "enterpriseuser",
            "email": "user@enterprise.com"
        }

        with patch('requests.get', return_value=mock_response) as mock_get:
            github_provider.validate_token(
                "ghp_enterprise_token",
                git_domain="git.enterprise.com"
            )

            # Should use custom API endpoint
            call_url = mock_get.call_args[0][0]
            assert "git.enterprise.com" in call_url

    def test_validate_token_network_error(self, github_provider):
        """Test validation with network error"""
        with patch('requests.get', side_effect=requests.exceptions.ConnectionError()):
            with pytest.raises(HTTPException) as exc_info:
                github_provider.validate_token("ghp_test_token")

            assert exc_info.value.status_code == 502


class TestGitHubProviderGetApiBaseUrl:
    """Test _get_api_base_url method"""

    def test_get_api_base_url_default(self, github_provider):
        """Test getting default GitHub API URL"""
        url = github_provider._get_api_base_url()

        assert url == "https://api.github.com"

    def test_get_api_base_url_github_com(self, github_provider):
        """Test getting GitHub.com API URL explicitly"""
        url = github_provider._get_api_base_url("github.com")

        assert url == "https://api.github.com"

    def test_get_api_base_url_enterprise(self, github_provider):
        """Test getting GitHub Enterprise API URL"""
        url = github_provider._get_api_base_url("git.example.com")

        assert url == "https://git.example.com/api/v3"


class TestGitHubProviderGetRepositories:
    """Test get_repositories method"""

    @pytest.mark.asyncio
    async def test_get_repositories_success(
        self,
        github_provider,
        mock_user_with_github
    ):
        """Test getting repositories successfully"""
        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.json.return_value = [
            {
                "id": 1,
                "name": "repo1",
                "full_name": "user/repo1",
                "clone_url": "https://github.com/user/repo1.git",
                "private": False
            },
            {
                "id": 2,
                "name": "repo2",
                "full_name": "user/repo2",
                "clone_url": "https://github.com/user/repo2.git",
                "private": True
            }
        ]

        with patch('requests.get', return_value=mock_response):
            repos = await github_provider.get_repositories(
                mock_user_with_github,
                page=1,
                limit=100
            )

            assert len(repos) == 2
            assert repos[0]["name"] == "repo1"
            assert repos[1]["private"] is True

    @pytest.mark.asyncio
    async def test_get_repositories_no_git_info(self, github_provider, test_user):
        """Test getting repositories when user has no git info"""
        with pytest.raises(HTTPException) as exc_info:
            await github_provider.get_repositories(test_user)

        assert exc_info.value.status_code == 400
        assert "not configured" in str(exc_info.value.detail).lower()


class TestGitHubProviderGetBranches:
    """Test get_branches method"""

    @pytest.mark.asyncio
    async def test_get_branches_success(
        self,
        github_provider,
        mock_user_with_github
    ):
        """Test getting branches successfully"""
        # Mock repository API response
        repo_response = Mock()
        repo_response.status_code = 200
        repo_response.json.return_value = {
            "default_branch": "main"
        }

        # Mock branches API response
        branches_response = Mock()
        branches_response.status_code = 200
        branches_response.json.return_value = [
            {
                "name": "main",
                "protected": True
            },
            {
                "name": "develop",
                "protected": False
            }
        ]

        with patch('requests.get') as mock_get:
            # First call gets default branch, second gets branches
            mock_get.side_effect = [repo_response, branches_response]

            branches = await github_provider.get_branches(
                mock_user_with_github,
                "user/repo",
                "github.com"
            )

            assert len(branches) == 2
            assert branches[0]["name"] == "main"
            assert branches[0]["default"] is True
            assert branches[1]["name"] == "develop"

    @pytest.mark.asyncio
    async def test_get_branches_no_token(self, github_provider, test_user):
        """Test getting branches when user has no token"""
        with pytest.raises(HTTPException) as exc_info:
            await github_provider.get_branches(
                test_user,
                "user/repo",
                "github.com"
            )

        assert exc_info.value.status_code == 400


class TestGitHubProviderSearchRepositories:
    """Test search_repositories method"""

    @pytest.mark.asyncio
    async def test_search_repositories_exact_match(
        self,
        github_provider,
        mock_user_with_github
    ):
        """Test searching repositories with exact match"""
        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.json.return_value = [
            {
                "id": 1,
                "name": "test-repo",
                "full_name": "user/test-repo",
                "clone_url": "https://github.com/user/test-repo.git",
                "private": False
            },
            {
                "id": 2,
                "name": "other-repo",
                "full_name": "user/other-repo",
                "clone_url": "https://github.com/user/other-repo.git",
                "private": False
            }
        ]

        with patch('requests.get', return_value=mock_response):
            with patch.object(
                github_provider,
                '_get_all_repositories_from_cache',
                return_value=None
            ):
                repos = await github_provider.search_repositories(
                    mock_user_with_github,
                    "test-repo",
                    fullmatch=True
                )

                # Should only return exact match
                assert len(repos) == 1
                assert repos[0]["name"] == "test-repo"

    @pytest.mark.asyncio
    async def test_search_repositories_partial_match(
        self,
        github_provider,
        mock_user_with_github
    ):
        """Test searching repositories with partial match"""
        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.json.return_value = [
            {
                "id": 1,
                "name": "test-repo",
                "full_name": "user/test-repo",
                "clone_url": "https://github.com/user/test-repo.git",
                "private": False
            },
            {
                "id": 2,
                "name": "test-another",
                "full_name": "user/test-another",
                "clone_url": "https://github.com/user/test-another.git",
                "private": False
            }
        ]

        with patch('requests.get', return_value=mock_response):
            with patch.object(
                github_provider,
                '_get_all_repositories_from_cache',
                return_value=None
            ):
                repos = await github_provider.search_repositories(
                    mock_user_with_github,
                    "test",
                    fullmatch=False
                )

                # Should return both matches
                assert len(repos) == 2
