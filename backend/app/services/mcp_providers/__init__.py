# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
MCP Provider Service

This module provides MCP provider management functionality.
The core implementation uses configuration-driven approach in the 'core' subpackage.
"""

# Re-export for backward compatibility
# Import from core module which initializes registry on load
from app.services.mcp_providers.core import MCPProviderRegistry

# Initialize registry with built-in providers
MCPProviderRegistry.initialize()

# Backward compatibility: provide PROVIDERS list from registry
# This creates MCPProviderDefinition objects from config for any legacy code
from dataclasses import dataclass
from typing import Awaitable, Callable, List

from app.schemas.mcp_provider_config import MCPProviderConfig
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
