# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the traced httpx client factories."""

import os

import httpx
import pytest

from shared.utils.http_client import (
    sanitize_no_proxy_env,
    traced_async_client,
    traced_sync_client,
)

# A typical container/VPN NO_PROXY: exact hosts plus IPv6 CIDR ranges. httpx
# turns every entry into a URL pattern, and `all://[fc00::/7]` raises
# `httpx.InvalidURL: Invalid port: ':'` while the client is being constructed.
IPV6_CIDR_NO_PROXY = "localhost,127.0.0.1,::1,fc00::/7,fe80::/10"


def _set_no_proxy(monkeypatch: pytest.MonkeyPatch, value: str) -> None:
    monkeypatch.setenv("NO_PROXY", value)
    monkeypatch.setenv("no_proxy", value)


def test_sanitize_no_proxy_env_drops_cidr_entries(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("NO_PROXY", IPV6_CIDR_NO_PROXY)
    monkeypatch.delenv("no_proxy", raising=False)

    removed = sanitize_no_proxy_env()

    assert removed == ["fc00::/7", "fe80::/10"]
    assert os.environ["NO_PROXY"] == "localhost,127.0.0.1,::1"


def test_sanitize_no_proxy_env_keeps_supported_entries(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("NO_PROXY", "localhost,.internal,*.example.com")
    monkeypatch.delenv("no_proxy", raising=False)

    assert sanitize_no_proxy_env() == []
    assert os.environ["NO_PROXY"] == "localhost,.internal,*.example.com"


def test_sanitize_no_proxy_env_keeps_url_entries(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("NO_PROXY", "http://localhost,192.168.0.0/16,example.com/path")
    monkeypatch.delenv("no_proxy", raising=False)

    assert sanitize_no_proxy_env() == ["192.168.0.0/16"]
    assert os.environ["NO_PROXY"] == "http://localhost,example.com/path"


def test_traced_sync_client_ignores_cidr_no_proxy(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_no_proxy(monkeypatch, IPV6_CIDR_NO_PROXY)

    with traced_sync_client(timeout=1.0) as client:
        assert client.timeout == httpx.Timeout(1.0)


def test_traced_sync_client_keeps_url_no_proxy_entry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_no_proxy(monkeypatch, "http://localhost")
    monkeypatch.setenv("HTTP_PROXY", "http://proxy.example.com:8080")

    with traced_sync_client(timeout=1.0) as client:
        assert client.timeout == httpx.Timeout(1.0)

    assert os.environ["NO_PROXY"] == "http://localhost"
    assert os.environ["no_proxy"] == "http://localhost"


async def test_traced_async_client_ignores_cidr_no_proxy(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_no_proxy(monkeypatch, IPV6_CIDR_NO_PROXY)

    async with traced_async_client(timeout=1.0) as client:
        assert client.timeout == httpx.Timeout(1.0)
