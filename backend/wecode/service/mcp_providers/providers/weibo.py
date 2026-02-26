# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
微博 MCP Provider

Weibo MCP Provider - Internal MCP service for Weibo employees
Uses current user's user_name as owner to fetch available MCP servers.
"""

import os
from typing import Any, Dict, List, Optional, Tuple

import httpx

from app.schemas.mcp_provider_config import (
    MCPProviderConfig,
    ProviderAPIConfig,
    ResponseMappingConfig,
    ServerMappingConfig,
)
from app.schemas.mcp_providers import MCPServer
from app.services.mcp_providers.providers.base import MCPProviderPlugin
from shared.logger import setup_logger

logger = setup_logger("mcp_providers.weibo")


class WeiboMCPProvider(MCPProviderPlugin):
    """微博 MCP Provider 插件

    使用当前登录用户的 user_name 作为 owner 获取可用的 MCP server 列表。
    需要两步操作：
    1. 使用系统 token 获取用户的 mcp token
    2. 使用 mcp token 获取 server 列表
    """

    MCP_BASE_URL = "http://mcp.intra.weibo.com"
    TOKEN_ENDPOINT = "/2/api/mcp/owner/token"
    SERVERS_ENDPOINT = "/2/api/mcp/servers/list"

    def get_config(self) -> MCPProviderConfig:
        """Return provider configuration"""
        return MCPProviderConfig(
            key="weibo",
            name="内部 MCP",
            name_en="Inner MCP",
            description="微博内部 MCP 服务，使用当前用户身份获取可用 MCP Server",
            discover_url="http://mcp.intra.weibo.com",
            api_key_url="http://mcp.intra.weibo.com",
            token_field="weibo_mcp",
            priority=0,  # 最高优先级，排在第一位
            requires_token=False,  # 不需要用户配置 token，使用当前用户 user_name
            api=ProviderAPIConfig(
                base_url=self.MCP_BASE_URL,
                list_path=self.SERVERS_ENDPOINT,
                method="GET",
                auth_template="Bearer {token}",
                timeout=30.0,
            ),
            mapping=ResponseMappingConfig(
                items_path="data.mcp_servers",
                page_param="page",
                size_param="page_size",
                page_size=100,
            ),
            server=ServerMappingConfig(
                id_field="id",
                name_field="name",
                description_field="intro",
                url_field="url",
                type_field="type",
                type_default="streamable-http",
                id_prefix="@weibo/",
            ),
        )

    async def fetch_servers(
        self, token: str, user_name: Optional[str] = None
    ) -> Tuple[List[MCPServer], Optional[str]]:
        """Fetch servers from Weibo MCP service

        Args:
            token: Not used for Weibo provider (user provides no token)
            user_name: Current user's user_name, used as owner

        Returns:
            Tuple of (servers, error_message)
        """
        # 使用 user_name 作为 owner
        owner = user_name
        if not owner:
            return [], "error: user_name not available"

        # 1. 获取系统 token
        system_token = os.environ.get("WEIBO_MCP_SYSTEM_TOKEN")
        if not system_token:
            logger.error("WEIBO_MCP_SYSTEM_TOKEN environment variable not set")
            return [], "error: WEIBO_MCP_SYSTEM_TOKEN not configured"

        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                # 2. 获取 mcp token
                mcp_token = await self._get_mcp_token(client, owner, system_token)
                if not mcp_token:
                    return [], "error: failed to get mcp token"

                # 3. 获取 server 列表
                servers_data = await self._get_servers(client, owner, mcp_token)

                # 4. 映射为 MCPServer 对象
                servers = self._map_servers(servers_data, mcp_token)

                return servers, None

        except httpx.HTTPError as e:
            logger.error("HTTP error fetching servers: %s", e)
            return [], f"http_error:{str(e)}"
        except Exception as e:
            logger.exception("Error fetching servers from Weibo MCP")
            return [], f"error:{str(e)}"

    async def _get_mcp_token(
        self, client: httpx.AsyncClient, owner: str, system_token: str
    ) -> Optional[str]:
        """Get MCP token for the owner

        Args:
            client: HTTP client
            owner: User's owner name (user_name)
            system_token: System-level authorization token

        Returns:
            MCP token string or None if failed
        """
        url = f"{self.MCP_BASE_URL}{self.TOKEN_ENDPOINT}"
        headers = {"Authorization": f"Bearer {system_token}"}
        params = {"owner": owner}

        logger.info("Fetching MCP token for owner: %s", owner)

        response = await client.get(url, headers=headers, params=params)
        response.raise_for_status()

        data = response.json()
        if data.get("code") != 0:
            logger.error("Failed to get MCP token: %s", data.get("message"))
            return None

        token = data.get("data", {}).get("token")
        if not token:
            logger.error("MCP token not found in response")
            return None

        return token

    async def _get_servers(
        self, client: httpx.AsyncClient, owner: str, mcp_token: str
    ) -> List[Dict[str, Any]]:
        """Get MCP servers list

        Args:
            client: HTTP client
            owner: User's owner name (user_name)
            mcp_token: MCP authorization token

        Returns:
            List of raw server data
        """
        url = f"{self.MCP_BASE_URL}{self.SERVERS_ENDPOINT}"
        headers = {"Authorization": f"Bearer {mcp_token}"}
        params = {"owner": owner}

        logger.info("Fetching MCP servers for owner: %s", owner)

        response = await client.get(url, headers=headers, params=params)
        response.raise_for_status()

        data = response.json()
        if data.get("code") != 0:
            logger.error("Failed to get servers: %s", data.get("message"))
            return []

        servers = data.get("data", {}).get("mcp_servers", [])
        logger.info("Found %d MCP servers for owner: %s", len(servers), owner)
        return servers

    def _map_servers(
        self, raw_servers: List[Dict[str, Any]], mcp_token: str
    ) -> List[MCPServer]:
        """Map raw server data to MCPServer objects

        Args:
            raw_servers: List of raw server data from API
            mcp_token: MCP token for authorization headers

        Returns:
            List of MCPServer objects
        """
        servers = []
        headers = {"Authorization": f"Bearer {mcp_token}"}

        for item in raw_servers:
            server_id = item.get("id")
            if not server_id:
                logger.warning("Skipping server without ID: %s", item)
                continue

            # 从 client_config.mcpServers.{id} 中提取 URL
            client_config = item.get("client_config", {})
            mcp_servers_config = client_config.get("mcpServers", {})
            server_config = mcp_servers_config.get(server_id, {})
            url = server_config.get("url")

            if not url:
                logger.warning("Skipping server %s without URL", server_id)
                continue

            server = MCPServer(
                id=f"@weibo/{server_id}",
                name=item.get("name") or server_id,
                description=item.get("intro"),
                type="streamable-http",
                base_url=url,
                command="",
                args=[],
                env={},
                headers=headers,
                is_active=True,
                provider="微博 MCP",
                provider_url=None,
                logo_url=None,
                tags=None,
            )
            servers.append(server)

        return servers


# Create provider instance for auto-discovery
Provider = WeiboMCPProvider
