# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
MCP Provider Built-in Configurations

Configuration for all built-in MCP providers.
"""

from app.schemas.mcp_provider_config import (
    MCPProviderConfig,
    ProviderAPIConfig,
    ResponseMappingConfig,
    ServerMappingConfig,
)

# Aliyun Bailian MCP Provider
BAILIAN_CONFIG = MCPProviderConfig(
    key="bailian",
    name="阿里云百炼",
    name_en="Aliyun Bailian",
    description="阿里云大模型服务平台百炼 MCP 市场",
    discover_url="https://bailian.console.aliyun.com/?tab=mcp#/mcp-market",
    api_key_url="https://bailian.console.aliyun.com/?tab=app#/api-key",
    token_field="bailian",
    api=ProviderAPIConfig(
        base_url="https://dashscope.aliyuncs.com",
        list_path="/api/v1/mcps/user/list",
        method="GET",
        query_params={},
        headers={},
        auth_template="Bearer {token}",
        timeout=30.0,
    ),
    mapping=ResponseMappingConfig(
        items_path="data",
        total_path="total",
        page_param="pageNo",
        size_param="pageSize",
        page_size=20,
        success_field="success",
        error_message_field="message",
    ),
    server=ServerMappingConfig(
        id_field="id",
        name_field="name",
        description_field="description",
        url_field="operationalUrl",
        type_field="type",
        type_default="streamable-http",
        provider_field="provider",
        provider_static=None,
        active_field="active",
        logo_field="logoUrl",
        tags_field="tags",
        id_prefix="@bailian/",
    ),
)

# ModelScope MCP Provider
MODELSCOPE_CONFIG = MCPProviderConfig(
    key="modelscope",
    name="ModelScope",
    name_en="ModelScope",
    description="ModelScope MCP 服务市场",
    discover_url="https://www.modelscope.cn/mcp",
    api_key_url="https://www.modelscope.cn/my/myaccesstoken",
    token_field="modelscope",
    api=ProviderAPIConfig(
        base_url="https://www.modelscope.cn",
        list_path="/api/v1/mcp/services/operational",
        method="GET",
        query_params={},
        headers={},
        auth_template="Bearer {token}",
        timeout=30.0,
    ),
    mapping=ResponseMappingConfig(
        items_path="Data.Result",
        total_path="Data.total",
        page_param="pageNum",
        size_param="pageSize",
        page_size=20,
        success_field="Success",
        error_message_field="Message",
    ),
    server=ServerMappingConfig(
        id_field="id",
        name_field="chinese_name",
        description_field="description",
        url_field="operational_urls[0].url",
        type_field="server_type",
        type_default="streamable-http",
        provider_field=None,
        provider_static="ModelScope",
        active_field=None,
        logo_field="logo_url",
        tags_field="tags",
        id_prefix="@modelscope/",
        name_fallback="name",
    ),
)

# MCP Router Provider
MCPROUTER_CONFIG = MCPProviderConfig(
    key="mcp_router",
    name="MCP Router",
    name_en="MCP Router",
    description="MCP Router 服务市场",
    discover_url="https://mcprouter.co",
    api_key_url="https://mcprouter.co/settings/api-keys",
    token_field="mcp_router",
    api=ProviderAPIConfig(
        base_url="https://api.mcprouter.to",
        list_path="/v1/list-servers",
        method="POST",
        query_params={},
        headers={
            "HTTP-Referer": "https://cherry-ai.com",
            "X-Title": "Wegent",
        },
        auth_template="Bearer {token}",
        timeout=30.0,
    ),
    mapping=ResponseMappingConfig(
        items_path="data.servers",
        total_path=None,
        page_param="page",
        size_param="page_size",
        page_size=100,
    ),
    server=ServerMappingConfig(
        id_field="server_key",
        name_field="title",
        description_field="description",
        url_field="server_url",
        type_field="type",
        type_default="streamable-http",
        provider_field=None,
        provider_static="MCPRouter",
        active_field=None,
        logo_field=None,
        tags_field=None,
        id_prefix="@mcprouter/",
        name_fallback="name",
    ),
)

# All built-in providers
# Note: Providers are now auto-discovered from providers/ directory
BUILTIN_PROVIDERS = []
