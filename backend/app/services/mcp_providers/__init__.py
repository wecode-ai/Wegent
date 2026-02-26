# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from dataclasses import dataclass
from typing import Awaitable, Callable, List

from app.schemas.mcp_providers import MCPServer
from app.services.mcp_providers.bailian import sync_bailian_servers
from app.services.mcp_providers.mcprouter import sync_mcprouter_servers
from app.services.mcp_providers.modelscope import sync_modelscope_servers


@dataclass
class MCPProviderDefinition:
    """MCP Provider definition"""

    key: str  # Unique identifier
    name: str  # Display name
    name_en: str  # English display name
    description: str  # Description
    discover_url: str  # URL to provider's MCP marketplace
    api_key_url: str  # URL to get API key
    token_field_name: str  # Field name in preferences
    sync_servers: Callable[[str], Awaitable[List[MCPServer]]]  # Sync function


# Provider instances
BAILIAN_PROVIDER = MCPProviderDefinition(
    key="bailian",
    name="阿里云百炼",
    name_en="Aliyun Bailian",
    description="阿里云大模型服务平台百炼 MCP 市场",
    discover_url="https://bailian.console.aliyun.com/?tab=mcp#/mcp-market",
    api_key_url="https://bailian.console.aliyun.com/?tab=app#/api-key",
    token_field_name="bailian",
    sync_servers=sync_bailian_servers,
)

MODELSCOPE_PROVIDER = MCPProviderDefinition(
    key="modelscope",
    name="ModelScope",
    name_en="ModelScope",
    description="ModelScope MCP 服务市场",
    discover_url="https://www.modelscope.cn/mcp",
    api_key_url="https://www.modelscope.cn/my/myaccesstoken",
    token_field_name="modelscope",
    sync_servers=sync_modelscope_servers,
)

MCPROUTER_PROVIDER = MCPProviderDefinition(
    key="mcp_router",
    name="MCP Router",
    name_en="MCP Router",
    description="MCP Router 服务市场",
    discover_url="https://mcprouter.co",
    api_key_url="https://mcprouter.co/settings/api-keys",
    token_field_name="mcp_router",
    sync_servers=sync_mcprouter_servers,
)

PROVIDERS = [BAILIAN_PROVIDER, MODELSCOPE_PROVIDER, MCPROUTER_PROVIDER]
