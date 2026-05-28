# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from app.models.kind import Kind
from app.schemas.installed_mcp import (
    InstalledMCPCustomCreateRequest,
    InstalledMCPInstallRequest,
    InstalledMCPServerConfig,
    InstalledMCPUpdateRequest,
    MCPInstallCatalogItem,
)
from app.services.installed_mcp_service import InstalledMCPService


def test_create_custom_mcp_stores_user_scoped_installed_mcp(test_db, test_user):
    service = InstalledMCPService()

    created = service.create_custom_mcp(
        db=test_db,
        user_id=test_user.id,
        request=InstalledMCPCustomCreateRequest(
            name="local-docs",
            displayName="Local Docs",
            description="Search local documentation",
            server=InstalledMCPServerConfig(
                type="streamable-http",
                url="https://mcp.example.com/docs",
                headers={"Authorization": "Bearer test"},
            ),
        ),
    )

    row = (
        test_db.query(Kind)
        .filter(
            Kind.id == int(created.metadata["labels"]["id"]),
            Kind.user_id == test_user.id,
            Kind.kind == "InstalledMCP",
            Kind.namespace == "default",
            Kind.is_active == True,
        )
        .one()
    )

    assert row.name == "local-docs"
    assert created.spec.source.type == "custom"
    assert created.spec.displayName == "Local Docs"
    assert created.spec.enabled is True
    assert created.spec.server.url == "https://mcp.example.com/docs"
    assert created.spec.server.headers == {"Authorization": "Bearer test"}


def test_install_provider_mcp_reactivates_existing_record(test_db, test_user):
    service = InstalledMCPService()
    request = InstalledMCPInstallRequest(
        providerKey="modelscope",
        serverKey="browser",
        catalogItemId="@modelscope/browser",
        displayName="Browser MCP",
        description="Browse pages",
        server=InstalledMCPServerConfig(
            type="streamable-http",
            url="https://mcp.example.com/browser",
        ),
    )

    first = service.install_provider_mcp(
        db=test_db, user_id=test_user.id, request=request
    )
    updated = service.update_installed_mcp(
        db=test_db,
        user_id=test_user.id,
        installed_id=int(first.metadata["labels"]["id"]),
        request=InstalledMCPUpdateRequest(enabled=False),
    )
    assert updated.spec.enabled is False

    second = service.install_provider_mcp(
        db=test_db, user_id=test_user.id, request=request
    )

    assert second.metadata["labels"]["id"] == first.metadata["labels"]["id"]
    assert second.spec.enabled is True
    assert second.spec.installState == "installed"


def test_uninstall_installed_mcp_soft_deletes_record(test_db, test_user):
    service = InstalledMCPService()
    created = service.create_custom_mcp(
        db=test_db,
        user_id=test_user.id,
        request=InstalledMCPCustomCreateRequest(
            name="local-shell",
            displayName="Local Shell",
            server=InstalledMCPServerConfig(type="stdio", command="uvx", args=["tool"]),
        ),
    )
    installed_id = int(created.metadata["labels"]["id"])

    service.uninstall_installed_mcp(
        db=test_db,
        user_id=test_user.id,
        installed_id=installed_id,
    )

    row = test_db.query(Kind).filter(Kind.id == installed_id).one()
    assert row.is_active is False
    assert row.json["spec"]["enabled"] is False
    assert row.json["spec"]["installState"] == "uninstalled"
    assert service.list_installed_mcps(db=test_db, user_id=test_user.id).items == []


def test_merge_catalog_state_marks_installed_items(test_db, test_user):
    service = InstalledMCPService()
    installed = service.install_provider_mcp(
        db=test_db,
        user_id=test_user.id,
        request=InstalledMCPInstallRequest(
            providerKey="bailian",
            serverKey="docs",
            catalogItemId="@bailian/docs",
            displayName="Docs MCP",
            server=InstalledMCPServerConfig(
                type="streamable-http",
                url="https://mcp.example.com/docs",
            ),
        ),
    )
    service.update_installed_mcp(
        db=test_db,
        user_id=test_user.id,
        installed_id=int(installed.metadata["labels"]["id"]),
        request=InstalledMCPUpdateRequest(enabled=False),
    )

    merged = service.merge_catalog_state(
        db=test_db,
        user_id=test_user.id,
        items=[
            MCPInstallCatalogItem(
                id="@bailian/docs",
                providerKey="bailian",
                serverKey="docs",
                name="Docs MCP",
                description="Docs",
                server=InstalledMCPServerConfig(
                    type="streamable-http",
                    url="https://mcp.example.com/docs",
                ),
            ),
            MCPInstallCatalogItem(
                id="@bailian/search",
                providerKey="bailian",
                serverKey="search",
                name="Search MCP",
                description="Search",
                server=InstalledMCPServerConfig(
                    type="streamable-http",
                    url="https://mcp.example.com/search",
                ),
            ),
        ],
    )

    assert merged[0].installState == "installed"
    assert merged[0].enabled is False
    assert merged[0].installedMcpId == int(installed.metadata["labels"]["id"])
    assert merged[1].installState == "not_installed"
    assert merged[1].enabled is False
    assert merged[1].installedMcpId is None
