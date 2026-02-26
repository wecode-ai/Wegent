# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import os
from typing import Any, List

import httpx

from app.schemas.mcp_providers import MCPServer
from shared.logger import setup_logger

logger = setup_logger("mcp_providers.mcprouter")

# Cherry Studio uses these MCPRouter endpoints:
# - Web host: https://mcprouter.co
# - API host: https://api.mcprouter.to
MCPROUTER_WEB_HOST = "https://mcprouter.co"
MCPROUTER_API_HOST = "https://api.mcprouter.to"


def _trust_env() -> bool:
    """
    Whether httpx should trust HTTP(S)_PROXY from environment.

    Default is False to avoid misconfigured proxy causing ConnectError.
    Set `MCP_PROVIDERS_TRUST_ENV=true` to opt in.
    """

    return os.environ.get("MCP_PROVIDERS_TRUST_ENV", "").lower() in {"1", "true", "yes"}


async def sync_mcprouter_servers(token: str) -> List[MCPServer]:
    """Sync MCP servers from MCP Router"""

    url = f"{MCPROUTER_API_HOST}/v1/list-servers"
    logger.info("Calling MCP Router API: %s", url)

    timeout = httpx.Timeout(connect=10.0, read=20.0, write=10.0, pool=10.0)
    async with httpx.AsyncClient(
        timeout=timeout,
        follow_redirects=True,
        trust_env=_trust_env(),
    ) as client:
        response = await client.post(
            url,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {token}",
                # Optional, but used by Cherry Studio and may be required by upstream.
                "HTTP-Referer": "https://cherry-ai.com",
                "X-Title": "Wegent",
            },
            json={},
        )

    if response.status_code in (401, 403):
        raise ValueError("unauthorized")
    if response.status_code == 500:
        raise ValueError("server_error")
    if not response.is_success:
        logger.error(
            "MCP Router HTTP error: status=%s body=%s",
            response.status_code,
            response.text,
        )
        raise ValueError(f"http_error:{response.status_code}")

    data: dict[str, Any] = response.json()
    items = (data.get("data") or {}).get("servers") or []
    if not isinstance(items, list):
        raise ValueError("api_error:invalid_payload")

    servers: List[MCPServer] = []
    for item in items:
        if not isinstance(item, dict):
            continue

        server_key = item.get("server_key")
        server_url = item.get("server_url")
        if not server_key or not server_url:
            continue

        servers.append(
            MCPServer(
                id=f"@mcprouter/{server_key}",
                name=item.get("title") or item.get("name") or "MCPRouter",
                description=item.get("description") or "",
                type="streamable-http",
                base_url=server_url,
                command="",
                args=[],
                env={},
                headers={"Authorization": f"Bearer {token}"},
                is_active=True,
                provider="MCPRouter",
                provider_url=f"{MCPROUTER_WEB_HOST}/{server_key}",
                logo_url=None,
                tags=[],
            )
        )

    return servers
