# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
MCP Provider Registry

Central registry for MCP providers with plugin architecture support.
"""

from typing import Dict, List, Optional

from app.schemas.mcp_provider_config import MCPProviderConfig
from app.schemas.mcp_providers import MCPServer
from app.services.mcp_providers.core.http_client import (
    HTTPClientError,
    MCPProviderHTTPClient,
)
from app.services.mcp_providers.core.mapper import DataMapper
from app.services.mcp_providers.providers.base import MCPProviderPlugin
from shared.logger import setup_logger

logger = setup_logger("mcp_providers.registry")


class MCPProviderRegistry:
    """Registry for MCP providers - supports plugins and auto-discovery"""

    _providers: Dict[str, MCPProviderConfig] = {}
    _plugins: Dict[str, MCPProviderPlugin] = {}
    _initialized: bool = False
    _custom_providers: list[tuple[MCPProviderConfig, bool]] = []  # (config, override)

    @classmethod
    def register(cls, config: MCPProviderConfig, override: bool = False) -> None:
        """Register a provider configuration

        Args:
            config: Provider configuration
            override: If True, override existing provider with same key
        """
        if config.key in cls._providers and not override:
            logger.warning(
                "Provider '%s' already registered, skipping. Use override=True to replace.",
                config.key,
            )
            return

        cls._providers[config.key] = config
        logger.info("Registered MCP provider: %s (%s)", config.name, config.key)

    @classmethod
    def register_plugin(cls, plugin: MCPProviderPlugin, override: bool = False) -> None:
        """Register a provider plugin

        Args:
            plugin: Provider plugin instance
            override: If True, override existing provider with same key
        """
        config = plugin.get_config()

        if config.key in cls._providers and not override:
            logger.warning(
                "Provider plugin '%s' already registered, skipping. Use override=True to replace.",
                config.key,
            )
            return

        cls._providers[config.key] = config
        cls._plugins[config.key] = plugin
        logger.info("Registered MCP provider plugin: %s (%s)", config.name, config.key)

    @classmethod
    def get(cls, key: str) -> Optional[MCPProviderConfig]:
        """Get provider configuration by key"""
        return cls._providers.get(key)

    @classmethod
    def get_plugin(cls, key: str) -> Optional[MCPProviderPlugin]:
        """Get provider plugin by key"""
        return cls._plugins.get(key)

    @classmethod
    def list_all(cls) -> List[MCPProviderConfig]:
        """List all registered providers, sorted by priority"""
        providers = list(cls._providers.values())
        # Sort by priority (lower = first), then by name
        return sorted(providers, key=lambda p: (getattr(p, "priority", 100), p.name))

    @classmethod
    def list_keys(cls) -> List[str]:
        """List all registered provider keys"""
        return list(cls._providers.keys())

    @classmethod
    def is_plugin(cls, key: str) -> bool:
        """Check if provider is a plugin (has custom mapping)"""
        return key in cls._plugins

    @classmethod
    async def sync_servers(
        cls, provider_key: str, token: str, user_name: Optional[str] = None
    ) -> tuple[List[MCPServer], Optional[str]]:
        """Sync servers from a provider

        For plugin providers, uses the plugin's custom fetch_servers method (full control).
        For config-based providers, uses the default HTTP client and DataMapper.

        Args:
            provider_key: The provider identifier
            token: The provider token (API key)
            user_name: Current user's username (for providers that need owner identity)

        Returns:
            tuple: (servers, error_message)
        """
        config = cls.get(provider_key)
        if not config:
            return [], f"Provider not found: {provider_key}"

        try:
            # Check if this is a plugin provider
            plugin = cls.get_plugin(provider_key)
            if plugin:
                # Use plugin's custom fetch_servers for full control
                return await plugin.fetch_servers(token, user_name)
            else:
                # Use default mapping logic
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
    def register_custom(cls, config: MCPProviderConfig, override: bool = False) -> None:
        """Register a custom provider (for internal/external extensions)

        These providers are tracked separately and registered after built-in ones.
        This allows internal projects to add their own providers without modifying
        open-source code.

        Args:
            config: Provider configuration
            override: If True, override existing provider with same key
        """
        cls._custom_providers.append((config, override))
        logger.debug("Queued custom provider: %s", config.key)

    @classmethod
    def initialize(cls) -> None:
        """Initialize registry with all providers (built-in + auto-discovered + custom)"""
        if cls._initialized:
            return

        # 1. Load legacy built-in providers (backward compatible)
        from app.services.mcp_providers.core.config import BUILTIN_PROVIDERS

        for provider_config in BUILTIN_PROVIDERS:
            cls.register(provider_config)

        # 2. Auto-discover config-based providers from providers/ directory
        try:
            from app.services.mcp_providers.providers import PROVIDER_CONFIGS

            for provider_config in PROVIDER_CONFIGS:
                if provider_config.key not in cls._providers:
                    cls.register(provider_config)
                else:
                    logger.debug(
                        "Auto-discovered config provider '%s' already registered, skipping",
                        provider_config.key,
                    )
        except ImportError as e:
            logger.warning("Could not auto-discover config providers: %s", e)

        # 3. Auto-discover plugin-based providers from providers/ directory
        try:
            from app.services.mcp_providers.providers import PROVIDER_PLUGINS

            for plugin in PROVIDER_PLUGINS:
                config = plugin.get_config()
                if config.key not in cls._providers:
                    cls.register_plugin(plugin)
                else:
                    logger.debug(
                        "Auto-discovered plugin provider '%s' already registered, skipping",
                        config.key,
                    )
        except ImportError as e:
            logger.warning("Could not auto-discover plugin providers: %s", e)

        # 4. Register custom providers (for internal/external extensions)
        for config, override in cls._custom_providers:
            cls.register(config, override=override)

        cls._initialized = True
        logger.info(
            "Initialized MCP provider registry with %d providers (%d plugins)",
            len(cls._providers),
            len(cls._plugins),
        )
