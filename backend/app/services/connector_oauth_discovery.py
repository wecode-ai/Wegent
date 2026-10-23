# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""RFC 9728/8414 discovery for connector OAuth servers."""

from __future__ import annotations

from typing import Any
from urllib.parse import urlsplit, urlunsplit

import httpx
from fastapi import HTTPException, status

from app.services.connector_apps import create_connector_http_client

DISCOVERY_TIMEOUT_SECONDS = 15


def _require_secure_url(value: str, *, field: str) -> str:
    parsed = urlsplit(value.strip())
    if parsed.scheme == "https" and parsed.hostname:
        return value.strip()
    # ``urlsplit`` strips the brackets from an IPv6 literal, so bare ``::1`` is
    # the hostname that actually reaches this check.
    loopback = parsed.hostname in {"localhost", "127.0.0.1", "::1"}
    if parsed.scheme == "http" and loopback:
        return value.strip()
    raise HTTPException(
        status.HTTP_400_BAD_REQUEST,
        f"Connector OAuth {field} must use https",
    )


async def _get_json(client: httpx.AsyncClient, url: str) -> dict[str, Any]:
    try:
        response = await client.get(url)
        response.raise_for_status()
        payload = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY, "Connector OAuth discovery failed"
        ) from exc
    if not isinstance(payload, dict):
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY,
            "Connector OAuth discovery returned no metadata",
        )
    return payload


async def _resource_metadata_url(client: httpx.AsyncClient, resource_url: str) -> str:
    try:
        response = await client.get(
            resource_url,
            headers={"Accept": "application/json, text/event-stream"},
        )
    except httpx.HTTPError as exc:
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY, "Connector OAuth discovery failed"
        ) from exc

    header = response.headers.get("www-authenticate", "")
    marker = 'resource_metadata="'
    if marker in header:
        start = header.index(marker) + len(marker)
        end = header.find('"', start)
        if end > start:
            return _require_secure_url(header[start:end], field="resource metadata URL")

    parsed = urlsplit(resource_url)
    origin = urlunsplit((parsed.scheme, parsed.netloc, "", "", ""))
    return f"{origin}/.well-known/oauth-protected-resource{parsed.path}"


async def discover_connector_oauth(resource_url: str) -> dict[str, Any]:
    resource_url = _require_secure_url(resource_url, field="resource URL")
    async with create_connector_http_client(
        timeout=httpx.Timeout(DISCOVERY_TIMEOUT_SECONDS)
    ) as client:
        metadata_url = await _resource_metadata_url(client, resource_url)
        resource = await _get_json(client, metadata_url)
        authorization_servers = resource.get("authorization_servers")
        if not isinstance(authorization_servers, list) or not authorization_servers:
            raise HTTPException(
                status.HTTP_502_BAD_GATEWAY,
                "Connector OAuth resource metadata has no authorization server",
            )
        issuer = _require_secure_url(
            str(authorization_servers[0]), field="authorization server"
        )
        # RFC 8414 places the well-known segment between host and issuer path:
        # https://as.example.com/tenant1 ->
        # https://as.example.com/.well-known/oauth-authorization-server/tenant1
        issuer_parts = urlsplit(issuer)
        issuer_path = issuer_parts.path.rstrip("/")
        metadata = await _get_json(
            client,
            f"{issuer_parts.scheme}://{issuer_parts.netloc}"
            f"/.well-known/oauth-authorization-server{issuer_path}",
        )

    authorization_endpoint = _require_secure_url(
        str(metadata.get("authorization_endpoint") or ""),
        field="authorization endpoint",
    )
    token_endpoint = _require_secure_url(
        str(metadata.get("token_endpoint") or ""),
        field="token endpoint",
    )
    registration_endpoint = metadata.get("registration_endpoint")
    scopes = metadata.get("scopes_supported")
    return {
        "resource": resource_url,
        "issuer": issuer,
        "authorization_endpoint": authorization_endpoint,
        "token_endpoint": token_endpoint,
        "registration_endpoint": (
            _require_secure_url(
                str(registration_endpoint), field="registration endpoint"
            )
            if registration_endpoint
            else None
        ),
        "scope": (
            " ".join(str(item) for item in scopes) if isinstance(scopes, list) else ""
        ),
    }
