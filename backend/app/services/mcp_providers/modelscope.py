# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from typing import List

import httpx

from app.schemas.mcp_providers import MCPServer
from shared.logger import setup_logger

logger = setup_logger("mcp_providers.modelscope")
MODELSCOPE_HOST = "https://www.modelscope.cn"


async def sync_modelscope_servers(token: str) -> List[MCPServer]:
    """Sync MCP servers from ModelScope"""
    servers = []
    page_num = 1
    page_size = 20

    async with httpx.AsyncClient() as client:
        while True:
            url = f"{MODELSCOPE_HOST}/api/v1/mcp/services/operational?pageNum={page_num}&pageSize={page_size}"
            response = await client.get(
                url,
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {token}",
                },
            )

            if response.status_code == 401:
                raise ValueError("unauthorized")
            if response.status_code == 500:
                raise ValueError("server_error")
            if not response.is_success:
                raise ValueError(f"http_error:{response.status_code}")

            data = response.json()

            if not data.get("Success") and not data.get("success"):
                raise ValueError(
                    f"api_error:{data.get('Message') or data.get('message')}"
                )

            # ModelScope returns data in Data.Result field
            items = data.get("Data", {}).get("Result", [])

            for server_data in items:
                # Get URL from operational_urls array
                operational_urls = server_data.get("operational_urls", [])
                if not operational_urls:
                    continue

                url = operational_urls[0].get("url")
                if not url:
                    continue

                # Get name - prefer chinese_name if available
                name = server_data.get("chinese_name") or server_data.get(
                    "name", "Unknown"
                )

                # Get ID - already in @modelscope/ format
                server_id = server_data.get("id", "unknown")

                server = MCPServer(
                    id=server_id,
                    name=name,
                    description=server_data.get("description", ""),
                    type="streamable-http",
                    base_url=url,
                    command="",
                    args=[],
                    env={},
                    headers={"Authorization": f"Bearer {token}"},
                    is_active=True,
                    provider="ModelScope",
                    provider_url=None,
                    logo_url=server_data.get("logo_url"),
                    tags=server_data.get("tags", []),
                )
                servers.append(server)

            # Check if there are more pages
            total = data.get("Data", {}).get("total", 0)
            if page_num * page_size >= total:
                break
            page_num += 1

    return servers
