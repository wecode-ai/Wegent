# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""The remote E2E uses bootstrap credentials independently of isolated users."""

import importlib.util
from pathlib import Path
from types import ModuleType
from unittest.mock import MagicMock

import httpx
import pytest


def _load_support(
    monkeypatch: pytest.MonkeyPatch, bootstrap_password: str
) -> ModuleType:
    monkeypatch.setenv("E2E_BOOTSTRAP_ADMIN_USER", "admin")
    monkeypatch.setenv("E2E_BOOTSTRAP_ADMIN_PASSWORD", bootstrap_password)
    monkeypatch.setenv("E2E_ADMIN_USER", "isolated-admin")
    monkeypatch.setenv("E2E_ADMIN_PASSWORD", "isolated-test-password")
    path = Path(__file__).resolve().parents[2] / "e2e/knowledge_remote_index_support.py"
    spec = importlib.util.spec_from_file_location("remote_e2e_login_support", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize("setup_status", [200, 409])
def test_login_keeps_bootstrap_credentials_paired(
    monkeypatch: pytest.MonkeyPatch, setup_status: int
) -> None:
    support = _load_support(monkeypatch, "bootstrap-test-password")
    client = MagicMock(spec=httpx.Client)
    client.post.side_effect = [
        httpx.Response(setup_status),
        httpx.Response(200, json={"access_token": "synthetic-token"}),
    ]
    client.get.return_value = httpx.Response(200, json={"id": 1})

    assert support._login(client) == ("synthetic-token", 1)

    assert client.post.call_args_list[0].kwargs["json"] == {
        "password": "bootstrap-test-password"
    }
    assert client.post.call_args_list[1].kwargs["json"] == {
        "user_name": "admin",
        "password": "bootstrap-test-password",
    }


def test_missing_bootstrap_password_does_not_use_isolated_credentials(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    support = _load_support(monkeypatch, "")
    client = MagicMock(spec=httpx.Client)

    with pytest.raises(
        support.KnowledgeRemoteIndexE2EError, match="E2E_BOOTSTRAP_ADMIN_PASSWORD"
    ):
        support._login(client)

    client.post.assert_not_called()
