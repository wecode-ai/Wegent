# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for explicit device Git credential synchronization."""

import json
import os
import shutil
import stat
import subprocess
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.services.device import git_credentials
from app.services.device.git_credentials_command import (
    GIT_CREDENTIALS_SECRET_ENV,
    SYNC_GIT_CREDENTIALS_COMMAND,
)


def _user(*accounts):
    return SimpleNamespace(id=7, user_name="alice", git_info=list(accounts))


def _account(domain, token, *, account_id, provider="gitea"):
    return {
        "id": account_id,
        "git_domain": domain,
        "git_token": token,
        "type": provider,
        "git_login": "alice",
        "git_email": "alice@example.com",
    }


def _run_sync_command(
    home: Path,
    accounts: list[dict],
    *,
    command_path: str | None = None,
) -> subprocess.CompletedProcess:
    environment = os.environ.copy()
    environment["HOME"] = str(home)
    environment["GIT_CONFIG_NOSYSTEM"] = "1"
    if command_path is not None:
        environment["PATH"] = command_path
    environment[GIT_CREDENTIALS_SECRET_ENV] = json.dumps(
        {"version": 1, "accounts": accounts}
    )
    return subprocess.run(
        ["sh", "-c", SYNC_GIT_CREDENTIALS_COMMAND],
        env=environment,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
    )


def _isolated_command_path(
    tmp_path: Path,
    *,
    tool: str | None,
    tool_exit_code: int = 0,
) -> str:
    bin_path = tmp_path / "bin"
    bin_path.mkdir()
    for command in ("git", "python3", "sh"):
        executable = shutil.which(command)
        assert executable is not None
        (bin_path / command).symlink_to(executable)
    if tool:
        executable = bin_path / tool
        executable.write_text(
            "#!/bin/sh\nread -r credential\n"
            '[ -n "$credential" ] || exit 97\n'
            f"exit {tool_exit_code}\n",
            encoding="utf-8",
        )
        executable.chmod(0o700)
    return str(bin_path)


def test_summary_preserves_order_and_hides_duplicate_tokens():
    user = _user(
        _account("https://Git.Example.com/", "first-secret", account_id="first"),
        _account("git.example.com", "duplicate-secret", account_id="second"),
        _account("git.other.example", "other-secret", account_id="third"),
    )

    summary = git_credentials.build_git_account_sync_summary(user)

    assert summary == {
        "accounts": [
            {
                "id": "first",
                "domain": "git.example.com",
                "provider": "gitea",
                "login": "alice",
                "email": "alice@example.com",
                "effective": True,
                "duplicate_of": None,
            },
            {
                "id": "second",
                "domain": "git.example.com",
                "provider": "gitea",
                "login": "alice",
                "email": "alice@example.com",
                "effective": False,
                "duplicate_of": "first",
            },
            {
                "id": "third",
                "domain": "git.other.example",
                "provider": "gitea",
                "login": "alice",
                "email": "alice@example.com",
                "effective": True,
                "duplicate_of": None,
            },
        ],
        "effective_count": 2,
        "duplicate_count": 1,
    }
    assert "secret" not in json.dumps(summary)


@pytest.mark.asyncio
async def test_sync_resolves_all_accounts_before_dispatch(monkeypatch):
    require_device = AsyncMock()
    dispatch = AsyncMock(
        return_value={
            "success": True,
            "stdout": {
                "synced_domains": ["git.example.com"],
                "removed_domains": [],
                "identity_warning_domains": [],
                "cli": [],
                "warnings": [],
            },
        }
    )

    @asynccontextmanager
    async def acquired(*_args, **_kwargs):
        yield True

    monkeypatch.setattr(git_credentials, "_require_eligible_device", require_device)
    monkeypatch.setattr(git_credentials, "execute_configured_device_command", dispatch)
    monkeypatch.setattr(
        git_credentials.distributed_lock,
        "acquire_watchdog_context_async",
        acquired,
    )
    user = _user(
        _account("git.example.com", "resolved-secret", account_id="first"),
        _account("git.example.com", "ignored-secret", account_id="second"),
    )

    result = await git_credentials.sync_git_accounts_to_device(
        SimpleNamespace(),
        user=user,
        device_id="remote-1",
        allow_empty=False,
    )

    require_device.assert_awaited_once()
    dispatch.assert_awaited_once()
    payload = json.loads(dispatch.await_args.kwargs["env"][GIT_CREDENTIALS_SECRET_ENV])
    assert len(payload["accounts"]) == 1
    assert payload["accounts"][0]["token"] == "resolved-secret"
    assert result["duplicate_domains"] == ["git.example.com"]
    assert "resolved-secret" not in json.dumps(result)


@pytest.mark.asyncio
async def test_unresolved_effective_token_aborts_before_dispatch(monkeypatch):
    dispatch = AsyncMock()
    monkeypatch.setattr(git_credentials, "_require_eligible_device", AsyncMock())
    monkeypatch.setattr(
        git_credentials, "resolve_plaintext_git_token", lambda *_args: ""
    )
    monkeypatch.setattr(git_credentials, "execute_configured_device_command", dispatch)

    with pytest.raises(
        git_credentials.DeviceGitCredentialResolutionError,
        match="unavailable",
    ):
        await git_credentials.sync_git_accounts_to_device(
            SimpleNamespace(),
            user=_user(_account("git.example.com", "***", account_id="first")),
            device_id="remote-1",
            allow_empty=False,
        )

    dispatch.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("git_login", "alice\n[credential]\nhelper=store"),
        ("git_email", "alice@example.com\n[include]\npath=/tmp/unsafe"),
        ("git_token", "secret\npassword=injected"),
    ],
)
async def test_multiline_account_values_abort_before_dispatch(
    monkeypatch,
    field,
    value,
):
    dispatch = AsyncMock()
    monkeypatch.setattr(git_credentials, "_require_eligible_device", AsyncMock())
    monkeypatch.setattr(git_credentials, "execute_configured_device_command", dispatch)
    account = _account("git.example.com", "safe-secret", account_id="first")
    account[field] = value

    with pytest.raises(
        git_credentials.DeviceGitCredentialResolutionError,
        match="invalid",
    ):
        await git_credentials.sync_git_accounts_to_device(
            SimpleNamespace(),
            user=_user(account),
            device_id="remote-1",
            allow_empty=False,
        )

    dispatch.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("spec", "online_info", "message"),
    [
        ({"deviceType": "local"}, None, "cloud or remote"),
        (
            {"deviceType": "remote", "bindShell": "openclaw"},
            None,
            "ClaudeCode",
        ),
        (
            {"deviceType": "remote", "bindShell": "claudecode"},
            {"status": "busy"},
            "online and idle",
        ),
        (
            {"deviceType": "remote", "bindShell": "claudecode"},
            {"socket_id": "missing-status"},
            "online and idle",
        ),
    ],
)
async def test_target_must_be_online_idle_claudecode_cloud_or_remote(
    monkeypatch,
    spec,
    online_info,
    message,
):
    monkeypatch.setattr(
        git_credentials.device_service,
        "get_device_by_device_id",
        lambda *_args: SimpleNamespace(json={"spec": spec}),
    )
    get_online = AsyncMock(return_value=online_info)
    monkeypatch.setattr(
        git_credentials.device_service,
        "get_device_online_info_by_type",
        get_online,
    )

    with pytest.raises(git_credentials.DeviceGitCredentialTargetError, match=message):
        await git_credentials._require_eligible_device(
            SimpleNamespace(), user_id=7, device_id="device-1"
        )


@pytest.mark.asyncio
async def test_cloud_target_uses_runtime_device_id_for_online_check(monkeypatch):
    monkeypatch.setattr(
        git_credentials.device_service,
        "get_device_by_device_id",
        lambda *_args: SimpleNamespace(
            json={
                "spec": {
                    "deviceType": "cloud",
                    "bindShell": "claudecode",
                    "cloudConfig": {"deviceId": "runtime-device-1"},
                }
            }
        ),
    )
    get_online = AsyncMock(return_value={"status": "online"})
    monkeypatch.setattr(
        git_credentials.device_service,
        "get_device_online_info_by_type",
        get_online,
    )

    await git_credentials._require_eligible_device(
        SimpleNamespace(), user_id=7, device_id="cloud-device-1"
    )

    assert get_online.await_args.args[1] == "runtime-device-1"


def test_device_command_reconciles_credentials_and_preserves_user_config(tmp_path):
    home = tmp_path / "home"
    home.mkdir()
    global_config = home / ".gitconfig"
    global_config.write_text(
        "[user]\n\tsigningKey = user-owned-key\n", encoding="utf-8"
    )
    first_token = "first-secret-value"
    first = {
        "domain": "git.example.com",
        "host": "git.example.com",
        "provider": "gitea",
        "token": first_token,
        "username": "alice",
        "identity_name": "Alice",
        "identity_email": "alice@example.com",
    }

    applied = _run_sync_command(home, [first])

    assert applied.returncode == 0, applied.stderr
    assert first_token not in applied.stdout
    assert json.loads(applied.stdout)["synced_domains"] == ["git.example.com"]
    current = home / ".wecode" / "git-auth" / "current"
    assert current.is_symlink()
    token_file = next((current / "tokens").iterdir())
    helper_file = current / "credential-helper"
    assert stat.S_IMODE(token_file.stat().st_mode) == 0o600
    assert stat.S_IMODE(helper_file.stat().st_mode) == 0o700

    environment = os.environ.copy()
    environment["HOME"] = str(home)
    environment["GIT_CONFIG_NOSYSTEM"] = "1"
    credential = subprocess.run(
        ["git", "credential", "fill"],
        env=environment,
        input="protocol=https\nhost=git.example.com\n\n",
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
    )
    assert credential.returncode == 0
    assert "username=alice" in credential.stdout
    assert f"password={first_token}" in credential.stdout

    repository = home / "repository"
    repository.mkdir()
    subprocess.run(["git", "init", "-q", str(repository)], env=environment, check=True)
    subprocess.run(
        [
            "git",
            "-C",
            str(repository),
            "remote",
            "add",
            "origin",
            "https://git.example.com/acme/repository.git",
        ],
        env=environment,
        check=True,
    )
    identity = subprocess.run(
        ["git", "-C", str(repository), "config", "--get", "user.email"],
        env=environment,
        stdout=subprocess.PIPE,
        text=True,
        check=True,
    )
    assert identity.stdout.strip() == "alice@example.com"

    second = {
        **first,
        "domain": "git.other.example",
        "host": "git.other.example",
        "token": "second-secret-value",
    }
    reconciled = _run_sync_command(home, [second])

    assert reconciled.returncode == 0, reconciled.stderr
    assert json.loads(reconciled.stdout)["removed_domains"] == ["git.example.com"]
    managed_contents = "\n".join(
        path.read_text(encoding="utf-8", errors="replace")
        for path in (home / ".wecode" / "git-auth").rglob("*")
        if path.is_file()
    )
    assert first_token not in managed_contents

    cleared = _run_sync_command(home, [])

    assert cleared.returncode == 0, cleared.stderr
    assert not (home / ".wecode" / "git-auth").exists()
    assert "user-owned-key" in global_config.read_text(encoding="utf-8")
    assert "git-auth/current/gitconfig" not in global_config.read_text(encoding="utf-8")


@pytest.mark.parametrize(
    ("provider", "tool", "tool_exit_code", "expected_status"),
    [
        ("github", "gh", 0, "configured"),
        ("gitlab", "glab", 9, "failed"),
        ("gitlab", None, 0, "not_installed"),
    ],
)
def test_device_command_reports_cli_outcome_without_affecting_git_auth(
    tmp_path,
    provider,
    tool,
    tool_exit_code,
    expected_status,
):
    home = tmp_path / "home"
    home.mkdir()
    command_path = _isolated_command_path(
        tmp_path,
        tool=tool,
        tool_exit_code=tool_exit_code,
    )
    token = "cli-test-secret"
    account = {
        "domain": f"{provider}.example.com",
        "host": f"{provider}.example.com",
        "provider": provider,
        "token": token,
        "username": "alice",
        "identity_name": "Alice",
        "identity_email": "alice@example.com",
    }

    applied = _run_sync_command(home, [account], command_path=command_path)

    assert applied.returncode == 0, applied.stderr
    assert token not in applied.stdout
    result = json.loads(applied.stdout)
    assert result["cli"] == [
        {
            "provider": "gh" if provider == "github" else "glab",
            "domain": f"{provider}.example.com",
            "status": expected_status,
            "reason_code": (
                None
                if expected_status == "configured"
                else (
                    "cli_auth_failed"
                    if expected_status == "failed"
                    else "cli_not_installed"
                )
            ),
        }
    ]

    environment = os.environ.copy()
    environment["HOME"] = str(home)
    environment["GIT_CONFIG_NOSYSTEM"] = "1"
    environment["PATH"] = command_path
    credential = subprocess.run(
        ["git", "credential", "fill"],
        env=environment,
        input=f"protocol=https\nhost={provider}.example.com\n\n",
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
    )
    assert credential.returncode == 0
    assert f"password={token}" in credential.stdout
    env_file = home / ".wecode" / "git-auth" / "env.sh"
    assert env_file.exists() is (expected_status == "configured")
