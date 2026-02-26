# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
MCP Provider Auto-Discovery

Automatically discovers and exports all provider configurations from this package.

To add a new provider, simply create a new Python file in this directory
that exports a `config` variable containing an MCPProviderConfig instance.

Example:
    # my_provider.py
    from app.schemas.mcp_provider_config import MCPProviderConfig, ...

    config = MCPProviderConfig(
        key="my_provider",
        name="My Provider",
        ...
    )
"""

import importlib
import pkgutil
from typing import List

from app.schemas.mcp_provider_config import MCPProviderConfig
from shared.logger import setup_logger

logger = setup_logger(__name__)


def _discover_providers() -> List[MCPProviderConfig]:
    """Auto-discover all provider configurations in this package."""
    configs = []
    package_path = __path__  # type: ignore

    for _, name, is_pkg in pkgutil.iter_modules(package_path):
        # Skip packages and private modules
        if is_pkg or name.startswith("_"):
            continue

        try:
            module = importlib.import_module(f".{name}", package=__name__)

            # Look for `config` attribute that is an MCPProviderConfig instance
            if hasattr(module, "config"):
                config = module.config
                if isinstance(config, MCPProviderConfig):
                    configs.append(config)
                    logger.debug(
                        "Discovered MCP provider: %s from %s", config.key, name
                    )
                else:
                    logger.warning(
                        "Module %s has 'config' but it's not MCPProviderConfig, skipping",
                        name,
                    )
        except Exception as e:
            # Log but don't fail - one bad provider shouldn't break others
            logger.warning("Failed to load provider module '%s': %s", name, e)

    return configs


# Auto-discover on module load
PROVIDER_CONFIGS: List[MCPProviderConfig] = _discover_providers()

if PROVIDER_CONFIGS:
    logger.info(
        "Auto-discovered %d MCP providers: %s",
        len(PROVIDER_CONFIGS),
        [c.key for c in PROVIDER_CONFIGS],
    )
