# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
MCP Provider Plugin Base Class

This module defines the base class for MCP provider plugins.
Providers can inherit from MCPProviderPlugin to have full control over
data fetching and mapping logic.

Usage:
    # For simple providers (use default mapper)
    config = MCPProviderConfig(...)

    # For complex providers (custom fetching and mapping)
    class Provider(MCPProviderPlugin):
        def get_config(self) -> MCPProviderConfig:
            return MCPProviderConfig(...)

        async def fetch_servers(self, token: str) -> Tuple[List[MCPServer], Optional[str]]:
            # Custom fetching logic
            ...
"""

from abc import ABC, abstractmethod
from typing import Any, Dict, List, Optional, Tuple

from app.schemas.mcp_provider_config import MCPProviderConfig
from app.schemas.mcp_providers import MCPServer


class MCPProviderPlugin(ABC):
    """Base class for MCP provider plugins

    Providers can inherit this class to have full control over:
    1. Configuration
    2. Data fetching from provider API
    3. Data mapping from API response to MCPServer objects

    Example:
        class Provider(MCPProviderPlugin):
            def get_config(self) -> MCPProviderConfig:
                return MCPProviderConfig(
                    key="my_provider",
                    name="My Provider",
                    ...
                )

            async def fetch_servers(self, token: str) -> Tuple[List[MCPServer], Optional[str]]:
                # Custom fetching logic
                async with httpx.AsyncClient() as client:
                    resp = await client.get(...)
                    data = resp.json()
                    servers = self._map(data, token)
                    return servers, None
    """

    @abstractmethod
    def get_config(self) -> MCPProviderConfig:
        """Return provider configuration

        Returns:
            MCPProviderConfig: The configuration for this provider
        """
        pass

    async def fetch_servers(
        self, token: str, user_name: Optional[str] = None
    ) -> Tuple[List[MCPServer], Optional[str]]:
        """Fetch and map servers from the provider API

        Override this method to implement custom data fetching logic
        (e.g., special token handling, multiple API calls, non-standard APIs).

        Default implementation uses the standard HTTP client and mapper.

        Args:
            token: Authentication token for the provider (user's API key)
            user_name: Current user's username (for providers that need owner identity)

        Returns:
            Tuple of (servers, error_message). If successful, error_message is None.
        """
        from app.services.mcp_providers.core.http_client import MCPProviderHTTPClient
        from app.services.mcp_providers.core.mapper import DataMapper

        config = self.get_config()
        client = MCPProviderHTTPClient(config)
        mapper = DataMapper()

        try:
            raw_data = await client.fetch_all_servers(token)
            servers = self.map_servers(raw_data, token)
            return servers, None
        except Exception as e:
            return [], str(e)
        finally:
            await client.close()

    def map_servers(
        self, raw_data: List[Dict[str, Any]], token: str
    ) -> List[MCPServer]:
        """Map raw API data to MCPServer objects

        Override this method to implement custom mapping logic.
        Default implementation uses the standard DataMapper.

        Args:
            raw_data: List of raw server data from API response
            token: Authentication token for the provider

        Returns:
            List of MCPServer objects
        """
        from app.services.mcp_providers.core.mapper import DataMapper

        mapper = DataMapper()
        return mapper.map_servers(raw_data, self.get_config(), token)
