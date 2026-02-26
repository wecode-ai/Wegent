# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from typing import List

import httpx

from app.schemas.mcp_providers import MCPServer
from shared.logger import setup_logger

logger = setup_logger("mcp_providers.bailian")
BAILIAN_HOST = "https://dashscope.aliyuncs.com"


async def sync_bailian_servers(token: str) -> List[MCPServer]:
    """Sync MCP servers from Aliyun Bailian"""
    servers = []
    page_num = 1
    page_size = 20

    async with httpx.AsyncClient() as client:
        while True:
            url = f"{BAILIAN_HOST}/api/v1/mcps/user/list?pageNo={page_num}&pageSize={page_size}"
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
            if not data.get("success"):
                raise ValueError(f"api_error:{data.get('message')}")

            for server_data in data.get("data", []):
                if not server_data.get("operationalUrl"):
                    continue

                server = MCPServer(
                    id=f"@bailian/{server_data['id']}",
                    name=server_data.get("name", "Unknown"),
                    description=server_data.get("description", ""),
                    type=server_data.get("type", "streamable-http"),
                    base_url=server_data["operationalUrl"],
                    command="",
                    args=[],
                    env={},
                    headers={"Authorization": f"Bearer {token}"},
                    is_active=server_data.get("active", True),
                    provider=server_data.get("provider", "Bailian"),
                    provider_url=server_data.get("providerUrl"),
                    logo_url=server_data.get("logoUrl"),
                    tags=server_data.get("tags", []),
                )
                servers.append(server)

            total = data.get("total", 0)
            if page_num * page_size >= total:
                break
            page_num += 1

    return servers
