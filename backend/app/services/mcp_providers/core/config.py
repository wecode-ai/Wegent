# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Backward-compatible exports for MCP provider configurations.

Provider definitions live in ``providers/`` so each provider has one source
of truth and can be auto-discovered by the registry.
"""

from app.services.mcp_providers.providers.bailian import config as BAILIAN_CONFIG
from app.services.mcp_providers.providers.mcprouter import config as MCPROUTER_CONFIG
from app.services.mcp_providers.providers.modelscope import config as MODELSCOPE_CONFIG

# Kept for callers that still import the legacy built-in provider list.
# Providers are registered through auto-discovery.
BUILTIN_PROVIDERS = []

__all__ = [
    "BAILIAN_CONFIG",
    "MODELSCOPE_CONFIG",
    "MCPROUTER_CONFIG",
    "BUILTIN_PROVIDERS",
]
