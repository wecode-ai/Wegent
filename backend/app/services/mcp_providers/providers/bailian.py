# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
阿里云百炼 MCP Provider

Aliyun Bailian MCP Provider Configuration
https://bailian.console.aliyun.com/
"""

from app.schemas.mcp_provider_config import (
    MCPProviderConfig,
    ProviderAPIConfig,
    ResponseMappingConfig,
    ServerMappingConfig,
)

config = MCPProviderConfig(
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
