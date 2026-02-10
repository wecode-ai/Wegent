# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import httpx
import pytest

import app.services.mcp_providers.service as service_module
from app.schemas.user import MCPProviderKeys, UserPreferences
from app.services.mcp_providers import MCPProviderDefinition
from app.services.mcp_providers.service import MCPProviderService


@pytest.mark.anyio
async def test_sync_servers_sets_error_details_for_unauthorized(monkeypatch):
    async def _sync(_token: str):
        raise ValueError("unauthorized")

    provider = MCPProviderDefinition(
        key="mcp_router",
        name="MCP Router",
        name_en="MCP Router",
        description="test",
        discover_url="https://example.com",
        api_key_url="https://example.com",
        token_field_name="mcp_router",
        sync_servers=_sync,
    )
    monkeypatch.setattr(service_module, "PROVIDERS", [provider])

    preferences = UserPreferences(mcp_provider_keys=MCPProviderKeys(mcp_router="token"))
    success, _message, _servers, error_details = await MCPProviderService.sync_servers(
        provider_key="mcp_router",
        preferences=preferences,
    )

    assert success is False
    assert error_details == "unauthorized"


@pytest.mark.anyio
async def test_sync_servers_sets_error_details_for_server_error(monkeypatch):
    async def _sync(_token: str):
        raise ValueError("server_error")

    provider = MCPProviderDefinition(
        key="mcp_router",
        name="MCP Router",
        name_en="MCP Router",
        description="test",
        discover_url="https://example.com",
        api_key_url="https://example.com",
        token_field_name="mcp_router",
        sync_servers=_sync,
    )
    monkeypatch.setattr(service_module, "PROVIDERS", [provider])

    preferences = UserPreferences(mcp_provider_keys=MCPProviderKeys(mcp_router="token"))
    success, _message, _servers, error_details = await MCPProviderService.sync_servers(
        provider_key="mcp_router",
        preferences=preferences,
    )

    assert success is False
    assert error_details == "server_error"


@pytest.mark.anyio
async def test_sync_servers_handles_empty_exception_message(monkeypatch):
    async def _sync(_token: str):
        raise RuntimeError()

    provider = MCPProviderDefinition(
        key="mcp_router",
        name="MCP Router",
        name_en="MCP Router",
        description="test",
        discover_url="https://example.com",
        api_key_url="https://example.com",
        token_field_name="mcp_router",
        sync_servers=_sync,
    )
    monkeypatch.setattr(service_module, "PROVIDERS", [provider])

    preferences = UserPreferences(mcp_provider_keys=MCPProviderKeys(mcp_router="token"))
    success, _message, _servers, error_details = await MCPProviderService.sync_servers(
        provider_key="mcp_router",
        preferences=preferences,
    )

    assert success is False
    assert error_details == "RuntimeError"


@pytest.mark.anyio
async def test_sync_servers_handles_connect_error(monkeypatch):
    async def _sync(_token: str):
        raise httpx.ConnectError("boom")

    provider = MCPProviderDefinition(
        key="mcp_router",
        name="MCP Router",
        name_en="MCP Router",
        description="test",
        discover_url="https://example.com",
        api_key_url="https://example.com",
        token_field_name="mcp_router",
        sync_servers=_sync,
    )
    monkeypatch.setattr(service_module, "PROVIDERS", [provider])

    preferences = UserPreferences(mcp_provider_keys=MCPProviderKeys(mcp_router="token"))
    success, message, _servers, error_details = await MCPProviderService.sync_servers(
        provider_key="mcp_router",
        preferences=preferences,
    )

    assert success is False
    assert error_details == "connect_error"
    assert "Network error" in message
