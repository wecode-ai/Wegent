# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for cloud-device Git account payload construction."""

import pytest

from wecode.service.cloud_device_git_tokens import (
    build_cloud_device_git_accounts,
    build_git_token_envs,
)


def test_build_cloud_device_git_accounts_preserves_per_domain_identities():
    accounts = build_cloud_device_git_accounts(
        [
            {
                "type": "gitlab",
                "git_domain": "git.intra.weibo.com",
                "git_token": "intra-token",
                "git_login": "alice-intra",
                "git_email": "alice@intra.example.com",
            },
            {
                "type": "gitlab",
                "git_domain": "gitlab.weibo.cn",
                "git_token": "weibo-token",
                "git_login": "alice-weibo",
                "git_email": "alice@weibo.example.com",
            },
        ]
    )

    assert accounts == [
        {
            "domain": "git.intra.weibo.com",
            "host": "git.intra.weibo.com",
            "provider": "gitlab",
            "token": "intra-token",
            "username": "alice-intra",
            "identity_name": "alice-intra",
            "identity_email": "alice@intra.example.com",
        },
        {
            "domain": "gitlab.weibo.cn",
            "host": "gitlab.weibo.cn",
            "provider": "gitlab",
            "token": "weibo-token",
            "username": "alice-weibo",
            "identity_name": "alice-weibo",
            "identity_email": "alice@weibo.example.com",
        },
    ]
    assert build_git_token_envs(accounts) == {
        "GIT_INTRA_WEIBO_COM_TOKEN": "intra-token",
        "GITLAB_WEIBO_CN_TOKEN": "weibo-token",
    }


def test_build_cloud_device_git_accounts_keeps_incomplete_identity_non_blocking():
    accounts = build_cloud_device_git_accounts(
        [
            {
                "type": "gitlab",
                "git_domain": "git.intra.weibo.com",
                "git_token": "intra-token",
                "git_login": "",
                "git_email": "",
            }
        ]
    )

    assert accounts[0]["username"] == "oauth2"
    assert accounts[0]["identity_name"] is None
    assert accounts[0]["identity_email"] is None


def test_build_cloud_device_git_accounts_filters_unsupported_domains():
    accounts = build_cloud_device_git_accounts(
        [
            {
                "type": "gitlab",
                "git_domain": "unsupported.example.com",
                "git_token": "unsupported-token",
                "git_login": "alice",
                "git_email": "alice@example.com",
            }
        ]
    )

    assert accounts == []


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("git_token", "token\nunsafe"),
        ("git_login", "alice\n[user]"),
        ("git_email", "alice@example.com\n[include]"),
    ],
)
def test_build_cloud_device_git_accounts_rejects_multiline_values(field, value):
    account = {
        "type": "gitlab",
        "git_domain": "git.intra.weibo.com",
        "git_token": "intra-token",
        "git_login": "alice",
        "git_email": "alice@example.com",
    }
    account[field] = value

    with pytest.raises(ValueError, match="invalid"):
        build_cloud_device_git_accounts([account])
