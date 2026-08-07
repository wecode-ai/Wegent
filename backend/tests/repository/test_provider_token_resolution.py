# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Every provider must decrypt the stored credential before it calls out.

Tokens are written to ``users.git_info`` encrypted, and nothing between the session
user and a provider decrypts them: ``get_current_user`` deliberately does not, so
that an unrelated endpoint never depends on Git crypto configuration. Each provider
therefore has to do it itself, and each one builds its entries in its own copy of
``_get_git_infos`` — which is exactly how the same omission ended up in all five.

This is parametrized rather than written per provider so a sixth one cannot be added
with the omission intact.
"""

import pytest

from app.repository.gerrit_provider import GerritProvider
from app.repository.gitea_provider import GiteaProvider
from app.repository.gitee_provider import GiteeProvider
from app.repository.github_provider import GitHubProvider
from app.repository.gitlab_provider import GitLabProvider
from shared.utils.crypto import encrypt_git_token

PLAIN_TOKEN = "glpat-000000000000000000"

PROVIDERS = [
    pytest.param(GitHubProvider, "github", id="github"),
    pytest.param(GitLabProvider, "gitlab", id="gitlab"),
    pytest.param(GiteaProvider, "gitea", id="gitea"),
    pytest.param(GiteeProvider, "gitee", id="gitee"),
    pytest.param(GerritProvider, "gerrit", id="gerrit"),
]


@pytest.fixture(autouse=True)
def _crypto_env(monkeypatch):
    monkeypatch.setenv("GIT_TOKEN_AES_KEY", "12345678901234567890123456789012")
    monkeypatch.setenv("GIT_TOKEN_AES_IV", "1234567890123456")
    import shared.utils.crypto as crypto

    monkeypatch.setattr(crypto, "_aes_key", None)
    monkeypatch.setattr(crypto, "_aes_iv", None)


def _user(provider_type: str, token: str):
    from unittest.mock import Mock

    user = Mock()
    user.id = 1
    user.user_name = "testuser"
    user.git_info = [
        {
            "type": provider_type,
            "git_domain": f"{provider_type}.example.com",
            "git_token": token,
            # Gerrit refuses an entry without one; harmless to the others.
            "user_name": "testuser",
        }
    ]
    return user


@pytest.mark.unit
@pytest.mark.parametrize("provider_class,provider_type", PROVIDERS)
def test_a_stored_token_is_decrypted(provider_class, provider_type):
    """Sent as-is the ciphertext yields a 401, which reads as a bad credential
    rather than as the provider never having decrypted it."""
    provider = provider_class()
    user = _user(provider_type, encrypt_git_token(PLAIN_TOKEN))

    (entry,) = provider._get_git_infos(user)

    assert entry["git_token"] == PLAIN_TOKEN


@pytest.mark.unit
@pytest.mark.parametrize("provider_class,provider_type", PROVIDERS)
def test_a_plaintext_token_is_left_alone(provider_class, provider_type):
    """Deployments exist that put a usable token straight into git_info."""
    provider = provider_class()
    user = _user(provider_type, PLAIN_TOKEN)

    (entry,) = provider._get_git_infos(user)

    assert entry["git_token"] == PLAIN_TOKEN


@pytest.mark.unit
@pytest.mark.parametrize("provider_class,provider_type", PROVIDERS)
def test_the_placeholder_survives(provider_class, provider_type):
    """'***' means the real token is substituted in at call time by a deployment
    overlay. Rewriting it would destroy the marker that substitution looks for."""
    provider = provider_class()
    user = _user(provider_type, "***")

    (entry,) = provider._get_git_infos(user)

    assert entry["git_token"] == "***"


@pytest.mark.unit
@pytest.mark.parametrize("provider_class,provider_type", PROVIDERS)
def test_an_empty_token_stays_empty(provider_class, provider_type):
    """Callers test the token for emptiness to raise "not configured". Turning it
    into anything else would send them past that check."""
    provider = provider_class()
    user = _user(provider_type, "")

    (entry,) = provider._get_git_infos(user)

    assert entry["git_token"] == ""


# --- what a failed domain is allowed to say ----------------------------------


@pytest.mark.unit
def test_a_failed_domain_is_reported_without_rendering_the_exception(caplog):
    """The log must not carry the token, and Gitee is why.

    Gitee passes the credential as a query parameter, so a `requests` exception for
    one of its calls stringifies as "401 Client Error: ... for url:
    https://gitee.com/api/v5/user/repos?access_token=<the live token>". This helper
    is reached from exactly those calls, so rendering the exception would write a
    working credential into the log the first time a Gitee domain answered 401.

    The two things it exists to distinguish -- a refused token and an unreachable
    host -- are carried by the status and the exception class, neither of which
    quotes the request.
    """
    import logging

    import requests

    from app.repository.gitee_provider import GiteeProvider

    response = requests.Response()
    response.status_code = 401
    response.url = "https://gitee.com/api/v5/user/repos?access_token=SUPERSECRET"
    error = requests.exceptions.HTTPError(
        f"401 Client Error: Unauthorized for url: {response.url}", response=response
    )

    with caplog.at_level(logging.WARNING):
        GiteeProvider()._log_domain_failure("list repositories", "gitee.com", error)

    logged = caplog.text
    assert "SUPERSECRET" not in logged
    assert "access_token" not in logged
    # Still says enough to tell a refusal from an outage.
    assert "401" in logged
    assert "HTTPError" in logged
