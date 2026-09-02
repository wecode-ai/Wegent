# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import threading

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


@pytest.mark.anyio
async def test_sync_servers_merges_install_state_off_event_loop(
    monkeypatch, test_provider_config
):
    event_loop_thread = threading.get_ident()
    server = service_module.MCPServer(
        id="@test/server",
        name="Test server",
        description="Test",
        type="streamable-http",
        base_url="https://example.com/mcp",
        is_active=True,
        provider="Test",
    )

    async def mock_sync(key, token, user_name=None):
        return [server], None

    def merge_install_state(user_id, provider_key, servers):
        assert threading.get_ident() != event_loop_thread
        assert user_id == 42
        assert provider_key == "test_provider"
        return servers

    monkeypatch.setattr(MCPProviderRegistry, "sync_servers", mock_sync)
    monkeypatch.setattr(
        MCPProviderService,
        "_apply_install_state_for_user",
        merge_install_state,
    )
    MCPProviderRegistry.register(test_provider_config)
    preferences = UserPreferences(
        mcp_provider_keys=MCPProviderKeys(test_provider=encrypt_sensitive_data("token"))
    )

    success, _message, servers, error_details = await MCPProviderService.sync_servers(
        provider_key="test_provider",
        preferences=preferences,
        user_id=42,
    )

    assert success is True
    assert servers == [server]
    assert error_details is None


@pytest.mark.anyio
async def test_sync_servers_decrypts_token_off_event_loop(
    monkeypatch, test_provider_config
):
    event_loop_thread = threading.get_ident()
    decrypted_on: list[int] = []
    decrypt = service_module.decrypt_mcp_provider_key

    def tracked_decrypt(raw_value: str | None) -> str:
        decrypted_on.append(threading.get_ident())
        return decrypt(raw_value)

    async def mock_sync(key, token, user_name=None):
        assert token == "token"
        return [], None

    monkeypatch.setattr(service_module, "decrypt_mcp_provider_key", tracked_decrypt)
    monkeypatch.setattr(MCPProviderRegistry, "sync_servers", mock_sync)
    MCPProviderRegistry.register(test_provider_config)
    preferences = UserPreferences(
        mcp_provider_keys=MCPProviderKeys(test_provider=encrypt_sensitive_data("token"))
    )

    success, _message, _servers, error_details = await MCPProviderService.sync_servers(
        provider_key="test_provider",
        preferences=preferences,
    )

    assert success is True
    assert error_details is None
    assert decrypted_on
    assert all(thread_id != event_loop_thread for thread_id in decrypted_on)
