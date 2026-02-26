# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
MCP Provider Registry

Central registry for MCP providers with configuration-driven approach.
"""

from typing import Dict, List, Optional

from app.schemas.mcp_provider_config import MCPProviderConfig
from app.schemas.mcp_providers import MCPServer
from app.services.mcp_providers.core.http_client import (
    HTTPClientError,
    MCPProviderHTTPClient,
)
from app.services.mcp_providers.core.mapper import DataMapper
from shared.logger import setup_logger

logger = setup_logger("mcp_providers.registry")


class MCPProviderRegistry:
    """Registry for MCP providers - supports configuration-driven providers"""

    _providers: Dict[str, MCPProviderConfig] = {}
    _initialized: bool = False

    @classmethod
    def register(cls, config: MCPProviderConfig) -> None:
        """Register a provider configuration"""
        cls._providers[config.key] = config
        logger.info("Registered MCP provider: %s (%s)", config.name, config.key)

    @classmethod
    def get(cls, key: str) -> Optional[MCPProviderConfig]:
        """Get provider configuration by key"""
        return cls._providers.get(key)

    @classmethod
    def list_all(cls) -> List[MCPProviderConfig]:
        """List all registered providers"""
        return list(cls._providers.values())

    @classmethod
    def list_keys(cls) -> List[str]:
        """List all registered provider keys"""
        return list(cls._providers.keys())

    @classmethod
    async def sync_servers(
        cls, provider_key: str, token: str
    ) -> tuple[List[MCPServer], Optional[str]]:
        """Sync servers from a provider

        Returns:
            tuple: (servers, error_message)
        """
        config = cls.get(provider_key)
        if not config:
            return [], f"Provider not found: {provider_key}"

        try:
            client = MCPProviderHTTPClient(config)
            mapper = DataMapper()

            try:
                raw_servers = await client.fetch_all_servers(token)
                servers = mapper.map_servers(raw_servers, config, token)
                return servers, None
            finally:
                await client.close()

        except HTTPClientError as e:
            logger.error("HTTP error syncing %s: %s", provider_key, e)
            return [], e.code
        except Exception as e:
            logger.exception("Error syncing %s", provider_key)
            return [], f"error:{str(e)}"

    @classmethod
    def initialize(cls) -> None:
        """Initialize registry with built-in providers"""
        if cls._initialized:
            return

        # Import and register built-in providers
        from app.services.mcp_providers.core.config import BUILTIN_PROVIDERS

        for provider_config in BUILTIN_PROVIDERS:
            cls.register(provider_config)

        cls._initialized = True
        logger.info(
            "Initialized MCP provider registry with %d providers", len(cls._providers)
        )
