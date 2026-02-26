# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
MCP Router Provider

MCP Router Provider Configuration
https://mcprouter.co
"""

from app.schemas.mcp_provider_config import (
    MCPProviderConfig,
    ProviderAPIConfig,
    ResponseMappingConfig,
    ServerMappingConfig,
)

config = MCPProviderConfig(
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
