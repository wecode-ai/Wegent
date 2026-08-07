# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for how GitLabProvider resolves the credential it calls GitLab with.

Tokens are stored encrypted on the user, and nothing between the session user and
the provider decrypts them. So what is pinned here is that the provider does it
itself, at the single place entries are built, and that a domain whose credential
is refused says so rather than dropping out of the result in silence.
"""

from unittest.mock import AsyncMock, Mock, patch

import pytest
import requests

from app.repository.gitlab_provider import GitLabProvider
from shared.utils.crypto import encrypt_git_token

PLAIN_TOKEN = "glpat-000000000000000000"
DOMAIN = "gitlab.example.com"


@pytest.fixture(autouse=True)
def _crypto_env(monkeypatch):
    monkeypatch.setenv("GIT_TOKEN_AES_KEY", "12345678901234567890123456789012")
    monkeypatch.setenv("GIT_TOKEN_AES_IV", "1234567890123456")
    # The module caches the key on first use, so a test that runs after one which
    # left a different key would otherwise read the stale one.
    import shared.utils.crypto as crypto

    monkeypatch.setattr(crypto, "_aes_key", None)
    monkeypatch.setattr(crypto, "_aes_iv", None)


def _user(token: str) -> Mock:
    user = Mock()
    user.id = 1
    user.user_name = "testuser"
    user.git_info = [{"type": "gitlab", "git_domain": DOMAIN, "git_token": token}]
    return user


@pytest.fixture
def provider() -> GitLabProvider:
    return GitLabProvider()


@pytest.fixture
def _no_cache():
    """Keep the result-caching side of get_repositories out of the way.

    ``set`` is awaited, so it has to be an async double; ``generate_full_cache_key``
    is not.
    """
    cache = Mock(set=AsyncMock(), generate_full_cache_key=Mock(return_value="key"))
    with patch("app.repository.gitlab_provider.cache_manager", cache):
        yield cache


@pytest.mark.unit
class TestTokenResolution:
    def test_a_stored_token_is_decrypted_before_it_is_used(self, provider):
        """The ciphertext is not a credential. Sent as one it yields a 401, which
        reads as a bad token rather than as the provider never decrypting it."""
        user = _user(encrypt_git_token(PLAIN_TOKEN))

        (entry,) = provider._get_git_infos(user)

        assert entry["git_token"] == PLAIN_TOKEN

    def test_a_plaintext_token_is_left_alone(self, provider):
        """Deployments exist that put a usable token straight into git_info."""
        user = _user(PLAIN_TOKEN)

        (entry,) = provider._get_git_infos(user)

        assert entry["git_token"] == PLAIN_TOKEN

    def test_the_placeholder_is_left_alone(self, provider):
        """'***' means the token lives elsewhere and is substituted before the call.
        Decrypting it would destroy the marker the substitution looks for."""
        user = _user("***")

        (entry,) = provider._get_git_infos(user)

        assert entry["git_token"] == "***"

    @pytest.mark.asyncio
    async def test_the_decrypted_token_is_what_reaches_gitlab(
        self, provider, _no_cache
    ):
        """Covers the whole path rather than the helper alone: a caller between
        _get_git_infos and the request could still pass the raw entry through."""
        user = _user(encrypt_git_token(PLAIN_TOKEN))
        response = Mock(status_code=200)
        response.json.return_value = []

        with (
            patch.object(
                provider, "_get_all_repositories_from_cache", return_value=None
            ),
            patch.object(
                provider, "_make_request_with_auth_retry", return_value=response
            ) as request,
        ):
            await provider.get_repositories(user, page=1, limit=10)

        assert request.call_args.kwargs["token"] == PLAIN_TOKEN


@pytest.mark.unit
class TestFailedDomainsAreReported:
    @pytest.mark.asyncio
    async def test_a_refused_domain_is_logged_rather_than_silently_skipped(
        self, provider, caplog
    ):
        """An empty list and a rejected credential must not look alike. This is the
        signal that turns 'this user has no repositories' back into a diagnosis."""
        user = _user(encrypt_git_token(PLAIN_TOKEN))
        refused = requests.exceptions.HTTPError("401 Unauthorized")
        refused.response = Mock(status_code=401)

        with (
            patch.object(
                provider, "_get_all_repositories_from_cache", return_value=None
            ),
            patch.object(
                provider, "_make_request_with_auth_retry", side_effect=refused
            ),
            caplog.at_level("WARNING"),
        ):
            result = await provider.get_repositories(user, page=1, limit=10)

        assert result == []
        assert DOMAIN in caplog.text
        assert "401" in caplog.text

    @pytest.mark.asyncio
    async def test_one_bad_domain_does_not_lose_a_good_one(self, provider, _no_cache):
        """Reporting the failure must not turn a partial result into no result."""
        user = _user(encrypt_git_token(PLAIN_TOKEN))
        user.git_info.append(
            {
                "type": "gitlab",
                "git_domain": "gitlab.other.com",
                "git_token": PLAIN_TOKEN,
            }
        )
        good = Mock(status_code=200)
        good.json.return_value = [
            {
                "id": 7,
                "name": "repo",
                "path_with_namespace": "group/repo",
                "http_url_to_repo": "https://gitlab.other.com/group/repo.git",
                "visibility": "private",
            }
        ]
        refused = requests.exceptions.HTTPError("401 Unauthorized")
        refused.response = Mock(status_code=401)

        with (
            patch.object(
                provider, "_get_all_repositories_from_cache", return_value=None
            ),
            patch.object(
                provider, "_make_request_with_auth_retry", side_effect=[refused, good]
            ),
        ):
            result = await provider.get_repositories(user, page=1, limit=10)

        assert [repo["full_name"] for repo in result] == ["group/repo"]
