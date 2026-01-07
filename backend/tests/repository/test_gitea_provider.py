# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Tests for GiteaProvider pagination and X-Total-Count header handling
"""

import asyncio
from unittest.mock import AsyncMock, MagicMock, Mock, patch

import pytest

from app.repository.gitea_provider import GiteaProvider


@pytest.fixture
def mock_user():
    """Create a mock user object with Gitea git_info"""
    user = Mock()
    user.id = 1
    user.user_name = "testuser"
    user.git_info = [
        {
            "type": "gitea",
            "git_domain": "gitea.example.com",
            "git_token": "test_token",
            "user_name": "testuser",
        }
    ]
    return user


@pytest.fixture
def gitea_provider():
    """Create a GiteaProvider instance"""
    return GiteaProvider()


@pytest.mark.unit
class TestGiteaProviderPagination:
    """Test GiteaProvider pagination logic with X-Total-Count header"""

    @pytest.mark.asyncio
    async def test_fetch_all_repositories_with_x_total_count_header(
        self, gitea_provider, mock_user, mocker
    ):
        """Test that pagination correctly uses X-Total-Count header"""
        # Mock cache_manager
        mock_cache = mocker.patch("app.repository.gitea_provider.cache_manager")
        mock_cache.is_building = AsyncMock(return_value=False)
        mock_cache.set_building = AsyncMock()
        mock_cache.generate_full_cache_key = Mock(return_value="test_cache_key")
        mock_cache.set = AsyncMock()

        # Create mock responses for 3 pages (total 120 repos, 50 per page)
        def create_mock_response(page, repos_count, total_count):
            response = Mock()
            response.status_code = 200
            response.headers = {"X-Total-Count": str(total_count)}
            response.json.return_value = [
                {
                    "id": i + (page - 1) * 50,
                    "name": f"repo-{i + (page - 1) * 50}",
                    "full_name": f"user/repo-{i + (page - 1) * 50}",
                    "clone_url": f"https://gitea.example.com/user/repo-{i + (page - 1) * 50}.git",
                    "private": False,
                }
                for i in range(repos_count)
            ]
            response.raise_for_status = Mock()
            return response

        # Page 1: 50 repos, Page 2: 50 repos, Page 3: 20 repos (total 120)
        responses = [
            create_mock_response(1, 50, 120),
            create_mock_response(2, 50, 120),
            create_mock_response(3, 20, 120),
        ]
        call_count = [0]

        def mock_request(*args, **kwargs):
            response = responses[call_count[0]]
            call_count[0] += 1
            return response

        mocker.patch(
            "asyncio.to_thread",
            side_effect=lambda func, *args, **kwargs: mock_request(),
        )

        await gitea_provider._fetch_all_repositories_async(
            mock_user, "test_token", "gitea.example.com"
        )

        # Verify cache was set with all 120 repos
        mock_cache.set.assert_called_once()
        call_args = mock_cache.set.call_args
        cached_repos = call_args[0][1]
        assert len(cached_repos) == 120

    @pytest.mark.asyncio
    async def test_fetch_all_repositories_stops_when_total_reached(
        self, gitea_provider, mock_user, mocker
    ):
        """Test that pagination stops when total count is reached"""
        mock_cache = mocker.patch("app.repository.gitea_provider.cache_manager")
        mock_cache.is_building = AsyncMock(return_value=False)
        mock_cache.set_building = AsyncMock()
        mock_cache.generate_full_cache_key = Mock(return_value="test_cache_key")
        mock_cache.set = AsyncMock()

        # Mock response with exactly 50 repos and X-Total-Count = 50
        response = Mock()
        response.status_code = 200
        response.headers = {"X-Total-Count": "50"}
        response.json.return_value = [
            {
                "id": i,
                "name": f"repo-{i}",
                "full_name": f"user/repo-{i}",
                "clone_url": f"https://gitea.example.com/user/repo-{i}.git",
                "private": False,
            }
            for i in range(50)
        ]
        response.raise_for_status = Mock()

        call_count = [0]

        def mock_request(*args, **kwargs):
            call_count[0] += 1
            return response

        mocker.patch(
            "asyncio.to_thread",
            side_effect=lambda func, *args, **kwargs: mock_request(),
        )

        await gitea_provider._fetch_all_repositories_async(
            mock_user, "test_token", "gitea.example.com"
        )

        # Should only call API once since total (50) equals fetched count (50)
        assert call_count[0] == 1

    @pytest.mark.asyncio
    async def test_fetch_all_repositories_fallback_without_header(
        self, gitea_provider, mock_user, mocker
    ):
        """Test fallback to old logic when X-Total-Count header is missing"""
        mock_cache = mocker.patch("app.repository.gitea_provider.cache_manager")
        mock_cache.is_building = AsyncMock(return_value=False)
        mock_cache.set_building = AsyncMock()
        mock_cache.generate_full_cache_key = Mock(return_value="test_cache_key")
        mock_cache.set = AsyncMock()

        # Create responses without X-Total-Count header
        def create_mock_response(repos_count):
            response = Mock()
            response.status_code = 200
            response.headers = {}  # No X-Total-Count header
            response.json.return_value = [
                {
                    "id": i,
                    "name": f"repo-{i}",
                    "full_name": f"user/repo-{i}",
                    "clone_url": f"https://gitea.example.com/user/repo-{i}.git",
                    "private": False,
                }
                for i in range(repos_count)
            ]
            response.raise_for_status = Mock()
            return response

        # Page 1: 50 repos, Page 2: 30 repos (less than per_page, should stop)
        responses = [
            create_mock_response(50),
            create_mock_response(30),
        ]
        call_count = [0]

        def mock_request(*args, **kwargs):
            response = responses[min(call_count[0], len(responses) - 1)]
            call_count[0] += 1
            return response

        mocker.patch(
            "asyncio.to_thread",
            side_effect=lambda func, *args, **kwargs: mock_request(),
        )

        await gitea_provider._fetch_all_repositories_async(
            mock_user, "test_token", "gitea.example.com"
        )

        # Should call API twice (page 1 returns 50, page 2 returns 30 < 50)
        assert call_count[0] == 2

        # Verify cache was set with 80 repos
        mock_cache.set.assert_called_once()
        call_args = mock_cache.set.call_args
        cached_repos = call_args[0][1]
        assert len(cached_repos) == 80

    @pytest.mark.asyncio
    async def test_fetch_all_repositories_handles_malformed_header(
        self, gitea_provider, mock_user, mocker
    ):
        """Test that malformed X-Total-Count header is handled gracefully"""
        mock_cache = mocker.patch("app.repository.gitea_provider.cache_manager")
        mock_cache.is_building = AsyncMock(return_value=False)
        mock_cache.set_building = AsyncMock()
        mock_cache.generate_full_cache_key = Mock(return_value="test_cache_key")
        mock_cache.set = AsyncMock()

        # Create response with malformed X-Total-Count header
        def create_mock_response(repos_count):
            response = Mock()
            response.status_code = 200
            response.headers = {"X-Total-Count": "not_a_number"}  # Malformed header
            response.json.return_value = [
                {
                    "id": i,
                    "name": f"repo-{i}",
                    "full_name": f"user/repo-{i}",
                    "clone_url": f"https://gitea.example.com/user/repo-{i}.git",
                    "private": False,
                }
                for i in range(repos_count)
            ]
            response.raise_for_status = Mock()
            return response

        # Page 1: 50 repos, Page 2: 30 repos (should fall back to old logic)
        responses = [
            create_mock_response(50),
            create_mock_response(30),
        ]
        call_count = [0]

        def mock_request(*args, **kwargs):
            response = responses[min(call_count[0], len(responses) - 1)]
            call_count[0] += 1
            return response

        mocker.patch(
            "asyncio.to_thread",
            side_effect=lambda func, *args, **kwargs: mock_request(),
        )

        # Should not raise an exception
        await gitea_provider._fetch_all_repositories_async(
            mock_user, "test_token", "gitea.example.com"
        )

        # Should fall back to old logic: page 2 returns < 50, so stops
        assert call_count[0] == 2

    @pytest.mark.asyncio
    async def test_get_repositories_triggers_async_fetch_when_has_more(
        self, gitea_provider, mock_user, mocker
    ):
        """Test that get_repositories triggers async fetch when X-Total-Count indicates more repos"""
        mock_cache = mocker.patch("app.repository.gitea_provider.cache_manager")
        mock_cache.is_building = AsyncMock(return_value=False)
        mock_cache.set_building = AsyncMock()
        mock_cache.generate_full_cache_key = Mock(return_value="test_cache_key")
        mock_cache.set = AsyncMock()

        # Mock _get_all_repositories_from_cache to return None (no cache)
        mocker.patch.object(
            gitea_provider,
            "_get_all_repositories_from_cache",
            new=AsyncMock(return_value=None),
        )

        # Mock response with X-Total-Count showing more repos than returned
        response = Mock()
        response.status_code = 200
        response.headers = {"X-Total-Count": "150"}  # Total 150, but only returning 50
        response.json.return_value = [
            {
                "id": i,
                "name": f"repo-{i}",
                "full_name": f"user/repo-{i}",
                "clone_url": f"https://gitea.example.com/user/repo-{i}.git",
                "private": False,
            }
            for i in range(50)
        ]
        response.raise_for_status = Mock()

        mocker.patch("requests.get", return_value=response)

        # Mock asyncio.create_task to capture the call
        mock_create_task = mocker.patch("asyncio.create_task")

        repos = await gitea_provider.get_repositories(mock_user, page=1, limit=100)

        # Should have triggered async fetch since has_more = True
        mock_create_task.assert_called_once()

        # Should return the 50 repos from the response
        assert len(repos) == 50

    @pytest.mark.asyncio
    async def test_get_repositories_caches_when_no_more_repos(
        self, gitea_provider, mock_user, mocker
    ):
        """Test that get_repositories caches directly when X-Total-Count shows all repos fetched"""
        mock_cache = mocker.patch("app.repository.gitea_provider.cache_manager")
        mock_cache.is_building = AsyncMock(return_value=False)
        mock_cache.set_building = AsyncMock()
        mock_cache.generate_full_cache_key = Mock(return_value="test_cache_key")
        mock_cache.set = AsyncMock()

        # Mock _get_all_repositories_from_cache to return None (no cache)
        mocker.patch.object(
            gitea_provider,
            "_get_all_repositories_from_cache",
            new=AsyncMock(return_value=None),
        )

        # Mock response with X-Total-Count = 30 (all repos fetched)
        response = Mock()
        response.status_code = 200
        response.headers = {"X-Total-Count": "30"}
        response.json.return_value = [
            {
                "id": i,
                "name": f"repo-{i}",
                "full_name": f"user/repo-{i}",
                "clone_url": f"https://gitea.example.com/user/repo-{i}.git",
                "private": False,
            }
            for i in range(30)
        ]
        response.raise_for_status = Mock()

        mocker.patch("requests.get", return_value=response)

        # Mock asyncio.create_task
        mock_create_task = mocker.patch("asyncio.create_task")

        repos = await gitea_provider.get_repositories(mock_user, page=1, limit=100)

        # Should NOT trigger async fetch since all repos are already fetched
        mock_create_task.assert_not_called()

        # Should cache directly
        mock_cache.set.assert_called_once()

        # Should return 30 repos
        assert len(repos) == 30


@pytest.mark.unit
class TestGiteaProviderValidation:
    """Test GiteaProvider token validation"""

    def test_validate_token_with_valid_token(self, gitea_provider, mocker):
        """Test validate_token with a valid Gitea token"""
        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "id": 12345,
            "login": "testuser",
            "full_name": "Test User",
            "avatar_url": "https://gitea.example.com/avatars/testuser",
            "email": "test@example.com",
        }
        mock_response.raise_for_status = Mock()

        mocker.patch(
            "shared.utils.crypto.decrypt_git_token", return_value="valid_token"
        )
        mocker.patch("shared.utils.crypto.is_token_encrypted", return_value=True)
        mocker.patch("requests.get", return_value=mock_response)

        result = gitea_provider.validate_token(
            "valid_token", git_domain="gitea.example.com"
        )

        assert result["valid"] is True
        assert result["user"]["id"] == 12345
        assert result["user"]["login"] == "testuser"

    def test_validate_token_with_invalid_token(self, gitea_provider, mocker):
        """Test validate_token with an invalid Gitea token"""
        mock_response = Mock()
        mock_response.status_code = 401

        mocker.patch(
            "shared.utils.crypto.decrypt_git_token", return_value="invalid_token"
        )
        mocker.patch("shared.utils.crypto.is_token_encrypted", return_value=True)
        mocker.patch("requests.get", return_value=mock_response)

        result = gitea_provider.validate_token(
            "invalid_token", git_domain="gitea.example.com"
        )

        assert result["valid"] is False
