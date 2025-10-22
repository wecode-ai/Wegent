#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

from typing import Dict, Any, Optional, List, Tuple
from shared.logger import setup_logger

logger = setup_logger("mcp_utils")


def extract_mcp_servers_config(config: Dict[str, Any]) -> Optional[Any]:
    """
    Extract MCP servers configuration supporting multiple formats.
    Priority order:
    1) {"mcpServers": {"mcpServers": {...}}}
       {"mcpServers": {"mcp_servers": {...}}}
    2) {"mcp_servers": {"mcp_servers": {...}}}
       {"mcp_servers": {"mcpServers": {...}}}
    3) {"mcpServers": {...}}
    4) {"mcp_servers": {...}}
    5) Fallback: config.get("mcp_servers")
    """
    try:
        # Collect candidates as tuples: (variant, outer_key, inner_key, cfg)
        # variant: "double" or "single"
        candidates: List[Tuple[str, str, str, Dict[str, Any]]] = []
        for outer_key in ("mcpServers", "mcp_servers"):
            val = config.get(outer_key)
            if isinstance(val, dict):
                found_double = False
                # Support cross-key inner nesting:
                for inner_key in ("mcpServers", "mcp_servers"):
                    nested = val.get(inner_key)
                    if isinstance(nested, dict) and nested:
                        logger.info(f"Detected double-nested MCP config outer='{outer_key}', inner='{inner_key}'.")
                        candidates.append(("double", outer_key, inner_key, nested))
                        found_double = True
                # If no valid double-nested dicts were found, treat the dict itself as single
                if not found_double and val:
                    logger.info(f"Detected single-nested MCP config under '{outer_key}'.")
                    candidates.append(("single", outer_key, "", val))

        # Priority selection (strict order)
        # 1) {"mcpServers": {"mcpServers": {...}}}
        for variant, outer, inner, cfg in candidates:
            if variant == "double" and outer == "mcpServers" and inner == "mcpServers":
                return cfg
        #    {"mcpServers": {"mcp_servers": {...}}}
        for variant, outer, inner, cfg in candidates:
            if variant == "double" and outer == "mcpServers" and inner == "mcp_servers":
                return cfg
        # 2) {"mcp_servers": {"mcp_servers": {...}}}
        for variant, outer, inner, cfg in candidates:
            if variant == "double" and outer == "mcp_servers" and inner == "mcp_servers":
                return cfg
        #    {"mcp_servers": {"mcpServers": {...}}}
        for variant, outer, inner, cfg in candidates:
            if variant == "double" and outer == "mcp_servers" and inner == "mcpServers":
                return cfg
        # 3) {"mcpServers": {...}}
        for variant, outer, inner, cfg in candidates:
            if variant == "single" and outer == "mcpServers":
                return cfg
        # 4) {"mcp_servers": {...}}
        for variant, outer, inner, cfg in candidates:
            if variant == "single" and outer == "mcp_servers":
                return cfg

        # 5) Fallback: original behavior
        fallback = config.get("mcp_servers")
        if fallback is not None:
            logger.info("Using fallback 'mcp_servers' configuration.")
            return fallback
    except Exception as e:
        logger.warning(f"Failed to extract MCP servers configuration: {str(e)}")
    return None
