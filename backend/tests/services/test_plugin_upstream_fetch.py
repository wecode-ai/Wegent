# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for bounded upstream plugin downloads."""

from collections.abc import Callable

import httpx
import pytest

from app.services import plugin_upstream_fetch
from app.services.plugin_upstream_fetch import UpstreamFetchError


def _install_transport(
    monkeypatch: pytest.MonkeyPatch,
    handler: Callable[[httpx.Request], httpx.Response],
) -> None:
    transport = httpx.MockTransport(handler)
    client = httpx.Client(transport=transport, follow_redirects=False)
    monkeypatch.setattr(
        plugin_upstream_fetch.httpx,
        "Client",
        lambda **_kwargs: client,
    )
    monkeypatch.setattr(
        plugin_upstream_fetch, "validate_upstream_url", lambda _url: None
    )


def test_fetch_upstream_package_streams_within_limit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _install_transport(
        monkeypatch,
        lambda request: httpx.Response(200, content=b"plugin", request=request),
    )

    package = plugin_upstream_fetch.fetch_upstream_package(
        "https://plugins.example/plugin.zip"
    )

    assert package == b"plugin"


def test_fetch_upstream_package_rejects_declared_oversize(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(plugin_upstream_fetch, "MAX_PLUGIN_PACKAGE_SIZE_BYTES", 8)
    _install_transport(
        monkeypatch,
        lambda request: httpx.Response(
            200,
            headers={"content-length": "9"},
            request=request,
        ),
    )

    with pytest.raises(UpstreamFetchError, match="too large"):
        plugin_upstream_fetch.fetch_upstream_package(
            "https://plugins.example/plugin.zip"
        )


def test_fetch_upstream_package_rejects_invalid_declared_size(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _install_transport(
        monkeypatch,
        lambda request: httpx.Response(
            200,
            headers={"content-length": "-1"},
            request=request,
        ),
    )

    with pytest.raises(UpstreamFetchError, match="invalid Content-Length"):
        plugin_upstream_fetch.fetch_upstream_package(
            "https://plugins.example/plugin.zip"
        )


def test_fetch_upstream_package_rejects_streamed_oversize(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(plugin_upstream_fetch, "MAX_PLUGIN_PACKAGE_SIZE_BYTES", 8)
    _install_transport(
        monkeypatch,
        lambda request: httpx.Response(
            200,
            stream=httpx.ByteStream(b"123456789"),
            request=request,
        ),
    )

    with pytest.raises(UpstreamFetchError, match="too large"):
        plugin_upstream_fetch.fetch_upstream_package(
            "https://plugins.example/plugin.zip"
        )
