# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Register the real local catalog provider used by marketplace browser E2E."""

from app.schemas.mcp_provider_config import (
    MCPProviderConfig,
    ProviderAPIConfig,
    ResponseMappingConfig,
    ServerMappingConfig,
)
from app.services.mcp_providers import MCPProviderRegistry

MCPProviderRegistry.register(
    MCPProviderConfig(
        key="e2e_catalog",
        name="E2E Catalog",
        name_en="E2E Catalog",
        description="Local MCP catalog used by the real Backend E2E service",
        discover_url="http://127.0.0.1:9999/e2e/mcp-marketplace/servers",
        api_key_url="",
        token_field="e2e_catalog",
        requires_token=False,
        priority=0,
        api=ProviderAPIConfig(
            base_url="http://127.0.0.1:9999",
            list_path="/e2e/mcp-marketplace/servers",
            method="GET",
            timeout=10.0,
        ),
        mapping=ResponseMappingConfig(
            items_path="servers",
            total_path="total",
            page_param="page",
            size_param="pageSize",
            page_size=20,
            success_field="success",
            error_message_field="message",
        ),
        server=ServerMappingConfig(
            id_field="id",
            name_field="name",
            description_field="description",
            url_field="base_url",
            type_field="type",
            provider_static="E2E Catalog",
            active_field="is_active",
            tags_field="tags",
            id_prefix="@e2e/",
        ),
    )
)
