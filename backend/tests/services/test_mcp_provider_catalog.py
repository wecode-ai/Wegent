# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from app.schemas.installed_mcp import (
    InstalledMCPInstallRequest,
    InstalledMCPServerConfig,
)
from app.schemas.mcp_providers import MCPServer
from app.services.installed_mcp_service import installed_mcp_service
from app.services.mcp_providers.service import MCPProviderService


def test_apply_install_state_to_provider_servers(test_db, test_user):
    installed = installed_mcp_service.install_provider_mcp(
        db=test_db,
        user_id=test_user.id,
        request=InstalledMCPInstallRequest(
            providerKey="modelscope",
            serverKey="browser",
            catalogItemId="@modelscope/browser",
            displayName="Browser MCP",
            server=InstalledMCPServerConfig(
                type="streamable-http",
                url="https://mcp.example.com/browser",
            ),
        ),
    )
    installed_mcp_id = int(installed.metadata["labels"]["id"])

    servers = [
        MCPServer(
            id="@modelscope/browser",
            name="Browser MCP",
            description="Browse pages",
            type="streamable-http",
            base_url="https://mcp.example.com/browser",
            is_active=True,
            provider="ModelScope",
        ),
        MCPServer(
            id="@modelscope/search",
            name="Search MCP",
            description="Search docs",
            type="streamable-http",
            base_url="https://mcp.example.com/search",
            is_active=True,
            provider="ModelScope",
        ),
    ]

    merged = MCPProviderService.apply_install_state_to_servers(
        db=test_db,
        user_id=test_user.id,
        provider_key="modelscope",
        servers=servers,
    )

    assert merged[0].installedMcpId == installed_mcp_id
    assert merged[0].installState == "installed"
    assert merged[0].enabled is True
    assert merged[1].installedMcpId is None
    assert merged[1].installState == "not_installed"
    assert merged[1].enabled is False
