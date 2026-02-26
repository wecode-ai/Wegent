# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
MCP Provider Auto-Discovery

Automatically discovers and exports all provider configurations and plugins from this package.

Two discovery modes are supported:

1. Simple Mode (config-based):
   Export a `config` variable containing an MCPProviderConfig instance.
   The default DataMapper will be used for data transformation.

   Example:
       # my_provider.py
       from app.schemas.mcp_provider_config import MCPProviderConfig, ...

       config = MCPProviderConfig(
           key="my_provider",
           name="My Provider",
           ...
       )

2. Plugin Mode (class-based):
   Export a `Provider` class inheriting from MCPProviderPlugin.
   This gives you full control over data mapping logic.

   Example:
       # complex_provider.py
       from app.services.mcp_providers.providers.base import MCPProviderPlugin
       from app.schemas.mcp_providers import MCPServer

       class Provider(MCPProviderPlugin):
           def get_config(self) -> MCPProviderConfig:
               return MCPProviderConfig(...)

           def map_servers(self, raw_data, token):
               # Custom mapping logic
               return [MCPServer(...), ...]
"""

import importlib
import pkgutil
from typing import List, Tuple

from app.schemas.mcp_provider_config import MCPProviderConfig
from app.services.mcp_providers.providers.base import MCPProviderPlugin
from shared.logger import setup_logger

logger = setup_logger(__name__)


def _discover_providers() -> Tuple[List[MCPProviderConfig], List[MCPProviderPlugin]]:
    """Auto-discover all providers in this package.

    Returns:
        Tuple of (config-based providers, plugin-based providers)
    """
    configs: List[MCPProviderConfig] = []
    plugins: List[MCPProviderPlugin] = []
    package_path = __path__  # type: ignore

    for _, name, is_pkg in pkgutil.iter_modules(package_path):
        # Skip packages, private modules, and the base module
        if is_pkg or name.startswith("_") or name == "base":
            continue

        try:
            module = importlib.import_module(f".{name}", package=__name__)

            # Check for Provider class first (takes precedence)
            if hasattr(module, "Provider"):
                provider_class = module.Provider
                # Check if it's a valid plugin class
                if isinstance(provider_class, type) and issubclass(
                    provider_class, MCPProviderPlugin
                ):
                    try:
                        instance = provider_class()
                        plugins.append(instance)
                        logger.debug(
                            "Discovered MCP provider plugin: %s from %s",
                            instance.get_config().key,
                            name,
                        )
                        continue  # Skip config check if plugin is found
                    except Exception as e:
                        logger.warning(
                            "Failed to instantiate Provider class in %s: %s", name, e
                        )

            # Check for config variable (fallback)
            if hasattr(module, "config"):
                config = module.config
                if isinstance(config, MCPProviderConfig):
                    configs.append(config)
                    logger.debug(
                        "Discovered MCP provider config: %s from %s", config.key, name
                    )
                else:
                    logger.warning(
                        "Module %s has 'config' but it's not MCPProviderConfig, skipping",
                        name,
                    )

        except Exception as e:
            # Log but don't fail - one bad provider shouldn't break others
            logger.warning("Failed to load provider module '%s': %s", name, e)

    return configs, plugins


# Auto-discover on module load
_PROVIDERS = _discover_providers()
PROVIDER_CONFIGS: List[MCPProviderConfig] = _PROVIDERS[0]
PROVIDER_PLUGINS: List[MCPProviderPlugin] = _PROVIDERS[1]

# Log discovery results
if PROVIDER_CONFIGS:
    logger.info(
        "Auto-discovered %d config-based MCP providers: %s",
        len(PROVIDER_CONFIGS),
        [c.key for c in PROVIDER_CONFIGS],
    )

if PROVIDER_PLUGINS:
    logger.info(
        "Auto-discovered %d plugin-based MCP providers: %s",
        len(PROVIDER_PLUGINS),
        [p.get_config().key for p in PROVIDER_PLUGINS],
    )
