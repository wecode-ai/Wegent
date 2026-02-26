# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
MCP Provider Service

This module provides MCP provider management functionality.
The core implementation uses configuration-driven approach in the 'core' subpackage.

Usage:
    # Auto-discovery of built-in providers (default)
    from app.services.mcp_providers import MCPProviderRegistry
    MCPProviderRegistry.initialize()

    # For internal projects: register custom providers
    from app.services.mcp_providers import register_mcp_provider
    from app.schemas.mcp_provider_config import MCPProviderConfig

    register_mcp_provider(MCPProviderConfig(
        key="my_provider",
        name="My Provider",
        ...
    ))
    # Then initialize
    MCPProviderRegistry.initialize()
"""

from typing import List, Optional

from app.schemas.mcp_provider_config import MCPProviderConfig

# Re-export for backward compatibility
# Import from core module which initializes registry on load
from app.services.mcp_providers.core import MCPProviderRegistry


def register_mcp_provider(config: MCPProviderConfig, override: bool = False) -> None:
    """Register a custom MCP provider.

    This function is designed for internal/external projects to add their own
    MCP providers without modifying the open-source codebase.

    Providers registered this way are loaded after built-in providers during
    initialize(), allowing internal projects to extend or override providers.

    Args:
        config: The provider configuration to register
        override: If True, override existing provider with same key.
                 Use this to replace built-in providers with custom implementations.

    Example:
        # In your internal project's startup code (before calling initialize()):
        from app.services.mcp_providers import register_mcp_provider
        from app.schemas.mcp_provider_config import MCPProviderConfig, ...

        # Add a new internal provider
        register_mcp_provider(MCPProviderConfig(
            key="internal_provider",
            name="Internal Provider",
            api=ProviderAPIConfig(...),
            ...
        ))

        # Override a built-in provider with internal version
        register_mcp_provider(MCPProviderConfig(
            key="bailian",  # Same key as built-in
            name="阿里云百炼(内网)",
            api=ProviderAPIConfig(
                base_url="https://internal.example.com",  # Internal URL
                ...
            ),
            ...
        ), override=True)

        # Then initialize
        MCPProviderRegistry.initialize()
    """
    MCPProviderRegistry.register_custom(config, override)


def get_mcp_provider(key: str) -> Optional[MCPProviderConfig]:
    """Get provider configuration by key.

    Args:
        key: Provider key (e.g., "bailian", "modelscope")

    Returns:
        Provider configuration or None if not found
    """
    return MCPProviderRegistry.get(key)


def list_mcp_providers() -> List[MCPProviderConfig]:
    """List all registered providers.

    Returns:
        List of all provider configurations
    """
    return MCPProviderRegistry.list_all()


# Initialize registry with built-in providers
MCPProviderRegistry.initialize()

# Backward compatibility: provide PROVIDERS list from registry
# This creates MCPProviderDefinition objects from config for any legacy code
from dataclasses import dataclass
from typing import Awaitable, Callable

from app.schemas.mcp_providers import MCPServer


@dataclass
class MCPProviderDefinition:
    """MCP Provider definition (backward compatibility)"""

    key: str
    name: str
    name_en: str
    description: str
    discover_url: str
    api_key_url: str
    token_field_name: str
    sync_servers: Callable[[str], Awaitable[List[MCPServer]]]


def _create_sync_wrapper(config: MCPProviderConfig):
    """Create a sync function wrapper for a provider config"""

    async def sync_fn(token: str) -> List[MCPServer]:
        servers, error = await MCPProviderRegistry.sync_servers(config.key, token)
        if error:
            raise ValueError(error)
        return servers

    return sync_fn


# Create PROVIDERS list from registry for backward compatibility
PROVIDERS = [
    MCPProviderDefinition(
        key=config.key,
        name=config.name,
        name_en=config.name_en,
        description=config.description,
        discover_url=config.discover_url,
        api_key_url=config.api_key_url,
        token_field_name=config.token_field,
        sync_servers=_create_sync_wrapper(config),
    )
    for config in MCPProviderRegistry.list_all()
]
