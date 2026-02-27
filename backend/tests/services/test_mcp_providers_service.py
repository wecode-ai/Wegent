# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import httpx
import pytest

import app.services.mcp_providers.service as service_module
from app.schemas.mcp_provider_config import (
    MCPProviderConfig,
    ProviderAPIConfig,
    ResponseMappingConfig,
    ServerMappingConfig,
)
from app.schemas.user import MCPProviderKeys, UserPreferences
from app.services.mcp_providers.core.registry import MCPProviderRegistry
from app.services.mcp_providers.service import MCPProviderService
from shared.utils.crypto import encrypt_sensitive_data


@pytest.fixture
def test_provider_config():
    """Create a test provider configuration"""
    return MCPProviderConfig(
        key="test_provider",
        name="Test Provider",
        name_en="Test Provider",
        description="Test provider",
        discover_url="https://example.com",
        api_key_url="https://example.com/api-key",
        token_field="test_provider",
        api=ProviderAPIConfig(
            base_url="https://example.com",
            list_path="/api/servers",
            method="GET",
            auth_template="Bearer {token}",
        ),
        mapping=ResponseMappingConfig(
            items_path="data",
            total_path="total",
        ),
        server=ServerMappingConfig(
            id_field="id",
            name_field="name",
            url_field="url",
            id_prefix="@test/",
        ),
    )


@pytest.mark.anyio
async def test_sync_servers_sets_error_details_for_unauthorized(
    monkeypatch, test_provider_config
):
    async def mock_sync(key, token, user_name=None):
        return [], "unauthorized"

    monkeypatch.setattr(MCPProviderRegistry, "sync_servers", mock_sync)
    # Register test provider
    MCPProviderRegistry.register(test_provider_config)

    preferences = UserPreferences(
        mcp_provider_keys=MCPProviderKeys(test_provider=encrypt_sensitive_data("token"))
    )
    success, _message, _servers, error_details = await MCPProviderService.sync_servers(
        provider_key="test_provider",
        preferences=preferences,
    )

    assert success is False
    assert error_details == "unauthorized"


@pytest.mark.anyio
async def test_sync_servers_sets_error_details_for_server_error(
    monkeypatch, test_provider_config
):
    async def mock_sync(key, token, user_name=None):
        return [], "server_error"

    monkeypatch.setattr(MCPProviderRegistry, "sync_servers", mock_sync)
    MCPProviderRegistry.register(test_provider_config)

    preferences = UserPreferences(
        mcp_provider_keys=MCPProviderKeys(test_provider=encrypt_sensitive_data("token"))
    )
    success, _message, _servers, error_details = await MCPProviderService.sync_servers(
        provider_key="test_provider",
        preferences=preferences,
    )

    assert success is False
    assert error_details == "server_error"


@pytest.mark.anyio
async def test_sync_servers_handles_empty_exception_message(
    monkeypatch, test_provider_config
):
    async def mock_sync(key, token, user_name=None):
        return [], "RuntimeError"

    monkeypatch.setattr(MCPProviderRegistry, "sync_servers", mock_sync)
    MCPProviderRegistry.register(test_provider_config)

    preferences = UserPreferences(
        mcp_provider_keys=MCPProviderKeys(test_provider=encrypt_sensitive_data("token"))
    )
    success, _message, _servers, error_details = await MCPProviderService.sync_servers(
        provider_key="test_provider",
        preferences=preferences,
    )

    assert success is False
    assert error_details == "RuntimeError"


@pytest.mark.anyio
async def test_sync_servers_handles_connect_error(monkeypatch, test_provider_config):
    async def mock_sync(key, token, user_name=None):
        raise httpx.ConnectError("boom")

    monkeypatch.setattr(MCPProviderRegistry, "sync_servers", mock_sync)
    MCPProviderRegistry.register(test_provider_config)

    preferences = UserPreferences(
        mcp_provider_keys=MCPProviderKeys(test_provider=encrypt_sensitive_data("token"))
    )
    success, message, _servers, error_details = await MCPProviderService.sync_servers(
        provider_key="test_provider",
        preferences=preferences,
    )

    assert success is False
    assert error_details == "connect_error"
    assert "Network error" in message


@pytest.mark.anyio
async def test_sync_servers_rejects_plaintext_token(monkeypatch, test_provider_config):
    async def mock_sync(key, token, user_name=None):
        return [], None

    monkeypatch.setattr(MCPProviderRegistry, "sync_servers", mock_sync)
    MCPProviderRegistry.register(test_provider_config)

    preferences = UserPreferences(
        mcp_provider_keys=MCPProviderKeys(test_provider="plaintext")
    )
    success, message, _servers, error_details = await MCPProviderService.sync_servers(
        provider_key="test_provider",
        preferences=preferences,
    )

    assert success is False
    assert error_details == "invalid_api_key_format"
    assert "invalid" in message.lower()
