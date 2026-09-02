# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for task-scoped Git execution credentials."""

from types import SimpleNamespace

from app.services.execution import git_credentials
from shared.models.execution import (
    GIT_AUTH_TRANSPORT_DEVICE_LOCAL,
    GIT_AUTH_TRANSPORT_ENCRYPTED_REQUEST_TOKEN,
    GIT_AUTH_TRANSPORT_LEGACY_USER_SECRET,
    GIT_AUTH_TRANSPORT_NONE,
    ExecutionRequest,
)
from shared.utils.crypto import decrypt_git_token


def _user(git_info: list[dict]) -> SimpleNamespace:
    return SimpleNamespace(id=7, user_name="alice", git_info=git_info)


def test_build_execution_git_user_info_uses_exact_domain_account():
    user = _user(
        [
            {
                "git_domain": "github.com",
                "git_token": "github-token",
                "git_login": "github-alice",
            },
            {
                "git_domain": "gitlab.com",
                "git_token": "gitlab-token",
                "git_login": "gitlab-alice",
            },
        ]
    )

    user_info = git_credentials.build_execution_git_user_info(user, "gitlab.com")

    assert (
        git_credentials.classify_git_auth_transport(user_info)
        == GIT_AUTH_TRANSPORT_ENCRYPTED_REQUEST_TOKEN
    )
    assert user_info["git_login"] == "gitlab-alice"
    assert decrypt_git_token(user_info["git_token"]) == "gitlab-token"


def test_build_execution_git_user_info_does_not_fallback_for_known_domain():
    user = _user(
        [
            {
                "git_domain": "github.com",
                "git_token": "github-token",
                "git_login": "github-alice",
            }
        ]
    )

    user_info = git_credentials.build_execution_git_user_info(user, "git.example.com")

    assert (
        git_credentials.classify_git_auth_transport(user_info)
        == GIT_AUTH_TRANSPORT_NONE
    )
    assert user_info["git_token"] is None
    assert user_info["git_login"] is None


def test_masked_token_uses_registered_resolver(mocker):
    user = _user(
        [
            {
                "git_domain": "git.example.com",
                "git_token": "***",
                "git_login": "alice",
            }
        ]
    )
    resolver = mocker.Mock(return_value="resolved-token")
    mocker.patch.object(git_credentials, "_placeholder_token_resolver", resolver)

    user_info = git_credentials.build_execution_git_user_info(
        user, "https://git.example.com"
    )

    resolver.assert_called_once_with(user, "git.example.com")
    assert (
        git_credentials.classify_git_auth_transport(user_info)
        == GIT_AUTH_TRANSPORT_ENCRYPTED_REQUEST_TOKEN
    )
    assert decrypt_git_token(user_info["git_token"]) == "resolved-token"


def test_unresolved_masked_token_stays_on_legacy_secret_path(mocker):
    user = _user(
        [
            {
                "git_domain": "git.example.com",
                "git_token": "***",
                "git_login": "alice",
            }
        ]
    )
    mocker.patch.object(git_credentials, "_placeholder_token_resolver", None)

    user_info = git_credentials.build_execution_git_user_info(user, "git.example.com")

    assert (
        git_credentials.classify_git_auth_transport(user_info)
        == GIT_AUTH_TRANSPORT_LEGACY_USER_SECRET
    )
    assert user_info["git_token"] == "***"


def test_build_device_git_execution_payload_uses_device_credentials():
    request = ExecutionRequest(
        task_id=10,
        subtask_id=20,
        user={
            "id": 7,
            "name": "alice",
            "git_domain": "git.example.com",
            "git_login": "alice",
            "git_token": "encrypted-token",
            "gitToken": "legacy-token",
        },
        git_auth_transport=GIT_AUTH_TRANSPORT_ENCRYPTED_REQUEST_TOKEN,
        skill_identity_token="skill-jwt",
    )

    payload = git_credentials.build_device_git_execution_payload(request)

    assert payload["git_auth_transport"] == GIT_AUTH_TRANSPORT_DEVICE_LOCAL
    assert "git_token" not in payload["user"]
    assert "gitToken" not in payload["user"]
    assert payload["user"]["git_login"] == "alice"
    assert payload["skill_identity_token"] == "skill-jwt"
    assert request.user["git_token"] == "encrypted-token"


def test_extract_git_domain_supports_https_and_scp_urls():
    assert (
        git_credentials.extract_git_domain("https://github.com/org/repo.git")
        == "github.com"
    )
    assert (
        git_credentials.extract_git_domain("git@gitlab.com:org/repo.git")
        == "gitlab.com"
    )
