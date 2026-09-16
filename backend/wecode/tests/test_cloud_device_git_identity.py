# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Integration coverage for cloud-device Git commit identities."""

import json
import os
import subprocess
from pathlib import Path
from typing import Any

from app.services.device.git_credentials_command import (
    GIT_CREDENTIALS_SECRET_ENV,
    SYNC_GIT_CREDENTIALS_COMMAND,
)
from wecode.service.cloud_device_git_tokens import build_cloud_device_git_accounts


def _assert_repository_identity(
    home: Path,
    environment: dict[str, str],
    account: dict[str, Any],
    index: int,
) -> None:
    repository = home / f"repository-{index}"
    subprocess.run(
        ["git", "init", "-q", str(repository)],
        env=environment,
        check=True,
    )
    subprocess.run(
        [
            "git",
            "-C",
            str(repository),
            "remote",
            "add",
            "origin",
            f"https://{account['domain']}/acme/repository.git",
        ],
        env=environment,
        check=True,
    )
    for key, expected in (
        ("user.name", account["identity_name"]),
        ("user.email", account["identity_email"]),
    ):
        value = subprocess.run(
            ["git", "-C", str(repository), "config", "--get", key],
            env=environment,
            stdout=subprocess.PIPE,
            text=True,
            check=True,
        )
        assert value.stdout.strip() == expected


def test_cloud_device_accounts_select_commit_identity_by_remote_domain(tmp_path):
    home = tmp_path / "home"
    home.mkdir()
    accounts = build_cloud_device_git_accounts(
        [
            {
                "type": "gitlab",
                "git_domain": "git.intra.weibo.com",
                "git_token": "intra-secret",
                "git_login": "alice-intra",
                "git_email": "alice@intra.example.com",
            },
            {
                "type": "gitlab",
                "git_domain": "gitlab.weibo.cn",
                "git_token": "weibo-secret",
                "git_login": "alice-weibo",
                "git_email": "alice@weibo.example.com",
            },
        ]
    )
    environment = os.environ.copy()
    environment["HOME"] = str(home)
    environment["GIT_CONFIG_NOSYSTEM"] = "1"
    environment[GIT_CREDENTIALS_SECRET_ENV] = json.dumps(
        {"version": 1, "accounts": accounts},
        separators=(",", ":"),
    )

    applied = subprocess.run(
        ["sh", "-c", SYNC_GIT_CREDENTIALS_COMMAND],
        env=environment,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
    )

    assert applied.returncode == 0, applied.stderr
    assert "intra-secret" not in applied.stdout
    assert "weibo-secret" not in applied.stdout
    for index, account in enumerate(accounts):
        _assert_repository_identity(home, environment, account, index)
