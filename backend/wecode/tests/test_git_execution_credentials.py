# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for internal execution-time Git credential resolution."""

from types import SimpleNamespace

from app.services.execution.git_credentials import resolve_plaintext_git_token
from wecode.service import git_execution_credentials


def test_internal_git_token_resolver_uses_current_user_and_domain(mocker):
    resolve = mocker.patch.object(
        git_execution_credentials.token_resolver,
        "resolve_git_token",
        return_value="resolved-token",
    )
    user = SimpleNamespace(id=7, user_name="alice")

    token = git_execution_credentials._resolve_internal_git_token(
        user, "git.intra.weibo.com"
    )

    assert token == "resolved-token"
    resolve.assert_called_once_with(
        username="alice",
        git_domain="git.intra.weibo.com",
        fallback_token="***",
    )


def test_internal_placeholder_is_resolved_for_device_sync(mocker):
    resolve = mocker.patch.object(
        git_execution_credentials.token_resolver,
        "resolve_git_token",
        return_value="resolved-device-token",
    )
    user = SimpleNamespace(id=7, user_name="alice")
    account = {
        "git_domain": "git.intra.weibo.com",
        "git_token": "***",
    }

    token = resolve_plaintext_git_token(user, account)

    assert token == "resolved-device-token"
    resolve.assert_called_once_with(
        username="alice",
        git_domain="git.intra.weibo.com",
        fallback_token="***",
    )
