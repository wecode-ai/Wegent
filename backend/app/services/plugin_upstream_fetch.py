# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Safe HTTP fetch for administrator-configured Codex upstream mirrors."""

from __future__ import annotations

import ipaddress
import socket
from urllib.parse import urlparse

import httpx

MAX_REDIRECTS = 5


class UpstreamFetchError(ValueError):
    """Raised when an upstream URL is unsafe or cannot be fetched."""


def _resolve_host_ips(hostname: str) -> list[ipaddress._BaseAddress]:
    try:
        infos = socket.getaddrinfo(hostname, None)
    except socket.gaierror as exc:
        raise UpstreamFetchError(f"Cannot resolve upstream host: {hostname}") from exc
    addresses: list[ipaddress._BaseAddress] = []
    for info in infos:
        sockaddr = info[4]
        if not sockaddr:
            continue
        ip = ipaddress.ip_address(sockaddr[0])
        addresses.append(ip)
    if not addresses:
        raise UpstreamFetchError(f"Cannot resolve upstream host: {hostname}")
    return addresses


def _assert_public_host(hostname: str) -> None:
    lowered = hostname.strip().lower()
    if lowered in {"localhost", "metadata.google.internal"} or lowered.endswith(
        ".localhost"
    ):
        raise UpstreamFetchError("Upstream host is not allowed")
    for ip in _resolve_host_ips(hostname):
        if (
            ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_reserved
            or ip.is_multicast
        ):
            raise UpstreamFetchError("Upstream host resolves to a private address")


def validate_upstream_url(url: str) -> None:
    parsed = urlparse(url.strip())
    if parsed.scheme != "https":
        raise UpstreamFetchError("Upstream URL must use HTTPS")
    if not parsed.hostname:
        raise UpstreamFetchError("Upstream URL must include a hostname")
    if parsed.username or parsed.password:
        raise UpstreamFetchError("Upstream URL must not include credentials")
    _assert_public_host(parsed.hostname)


def fetch_upstream_package(url: str) -> bytes:
    """Download an upstream archive while blocking SSRF targets."""
    validate_upstream_url(url)
    current = url.strip()
    with httpx.Client(timeout=60, follow_redirects=False) as client:
        for _ in range(MAX_REDIRECTS + 1):
            response = client.get(current)
            if response.status_code in {301, 302, 303, 307, 308}:
                location = response.headers.get("location")
                if not location:
                    raise UpstreamFetchError("Upstream redirect is missing location")
                next_url = str(httpx.URL(current).join(location))
                validate_upstream_url(next_url)
                current = next_url
                continue
            response.raise_for_status()
            return response.content
    raise UpstreamFetchError("Too many upstream redirects")
