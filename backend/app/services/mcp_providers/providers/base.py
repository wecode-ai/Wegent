# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
MCP Provider Plugin Base Class

This module defines the base class for MCP provider plugins.
Providers can inherit from MCPProviderPlugin to have full control over
data mapping logic.

Usage:
    # For simple providers (use default mapper)
    config = MCPProviderConfig(...)

    # For complex providers (custom mapping logic)
    class Provider(MCPProviderPlugin):
        def get_config(self) -> MCPProviderConfig:
            return MCPProviderConfig(...)

        def map_servers(self, raw_data: List[dict], token: str) -> List[MCPServer]:
            # Custom mapping logic
            ...
"""

from abc import ABC, abstractmethod
from typing import Any, Dict, List, Optional

from app.schemas.mcp_provider_config import MCPProviderConfig
from app.schemas.mcp_providers import MCPServer


class MCPProviderPlugin(ABC):
    """Base class for MCP provider plugins

    Providers can inherit this class to have full control over:
    1. Configuration
    2. Data mapping from API response to MCPServer objects

    Example:
        class Provider(MCPProviderPlugin):
            def get_config(self) -> MCPProviderConfig:
                return MCPProviderConfig(
                    key="my_provider",
                    name="My Provider",
                    ...
                )

            def map_servers(self, raw_data: List[dict], token: str) -> List[MCPServer]:
                servers = []
                for item in raw_data:
                    servers.append(MCPServer(
                        id=f"@my/{item['id']}",
                        name=item['name'],
                        base_url=item['url'],
                        ...
                    ))
                return servers
    """

    @abstractmethod
    def get_config(self) -> MCPProviderConfig:
        """Return provider configuration

        Returns:
            MCPProviderConfig: The configuration for this provider
        """
        pass

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

    def fetch_servers(
        self, token: str, query_params: Optional[Dict[str, Any]] = None
    ) -> tuple[List[MCPServer], Optional[str]]:
        """Fetch and map servers from the provider API

        This is an optional method that providers can override to implement
        custom fetching logic (e.g., special pagination, multiple API calls).

        Args:
            token: Authentication token
            query_params: Optional query parameters

        Returns:
            Tuple of (servers, error_message)
        """
        from app.services.mcp_providers.core.http_client import MCPProviderHTTPClient

        config = self.get_config()
        client = MCPProviderHTTPClient(config)
        try:
            import asyncio

            raw_data = asyncio.run(client.fetch_all_servers(token))
            servers = self.map_servers(raw_data, token)
            return servers, None
        except Exception as e:
            return [], str(e)
        finally:
            import asyncio

            asyncio.run(client.close())
