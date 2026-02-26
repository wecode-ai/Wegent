# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
ModelScope MCP Provider

ModelScope MCP Provider Configuration
https://www.modelscope.cn/mcp
"""

from app.schemas.mcp_provider_config import (
    MCPProviderConfig,
    ProviderAPIConfig,
    ResponseMappingConfig,
    ServerMappingConfig,
)

config = MCPProviderConfig(
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
