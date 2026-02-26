# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Tests for MCP Provider auto-discovery and registration mechanisms.
"""

import pytest

from app.schemas.mcp_provider_config import (
    MCPProviderConfig,
    ProviderAPIConfig,
    ResponseMappingConfig,
    ServerMappingConfig,
)
from app.services.mcp_providers import (
    MCPProviderRegistry,
    get_mcp_provider,
    list_mcp_providers,
    register_mcp_provider,
)
from app.services.mcp_providers.providers import PROVIDER_CONFIGS, _discover_providers


class TestAutoDiscovery:
    """Test auto-discovery of providers from providers/ directory"""

    def test_discover_providers_returns_tuple(self):
        """Test that _discover_providers returns a tuple of (configs, plugins)"""
        result = _discover_providers()
        assert isinstance(result, tuple)
        assert len(result) == 2
        configs, plugins = result
        assert isinstance(configs, list)
        assert isinstance(plugins, list)

    def test_discovered_configs_are_valid(self):
        """Test that discovered configs are MCPProviderConfig instances"""
        configs, plugins = _discover_providers()
        for config in configs:
            assert isinstance(config, MCPProviderConfig)
            assert config.key is not None
            assert config.name is not None

    def test_provider_configs_exported(self):
        """Test that PROVIDER_CONFIGS is populated on module load"""
        assert isinstance(PROVIDER_CONFIGS, list)
        # Should have at least the built-in providers
        assert len(PROVIDER_CONFIGS) >= 3

    def test_built_in_providers_discovered(self):
        """Test that built-in providers are auto-discovered"""
        keys = [p.key for p in PROVIDER_CONFIGS]
        assert "bailian" in keys
        assert "modelscope" in keys
        assert "mcp_router" in keys


class TestExplicitRegistration:
    """Test explicit registration of custom providers"""

    @pytest.fixture
    def custom_config(self):
        """Create a test custom provider configuration"""
        return MCPProviderConfig(
            key="custom_test",
            name="Custom Test Provider",
            name_en="Custom Test Provider",
            description="A test custom provider",
            discover_url="https://test.example.com",
            api_key_url="https://test.example.com/key",
            token_field="custom_test",
            api=ProviderAPIConfig(
                base_url="https://api.test.example.com",
                list_path="/v1/servers",
                method="GET",
                auth_template="Bearer {token}",
            ),
            mapping=ResponseMappingConfig(
                items_path="data",
            ),
            server=ServerMappingConfig(
                id_field="id",
                name_field="name",
                url_field="url",
                id_prefix="@customtest/",
            ),
        )

    def test_register_mcp_provider_function_exists(self):
        """Test that register_mcp_provider function is exported"""
        assert callable(register_mcp_provider)

    def test_register_mcp_provider_queues_config(self, custom_config):
        """Test that register_mcp_provider adds config to queue"""
        # Clear any existing custom providers
        MCPProviderRegistry._custom_providers = []

        # Register a custom provider
        register_mcp_provider(custom_config)

        # Check it was queued
        assert len(MCPProviderRegistry._custom_providers) == 1
        assert MCPProviderRegistry._custom_providers[0][0] == custom_config
        assert MCPProviderRegistry._custom_providers[0][1] is False  # override=False

    def test_register_mcp_provider_with_override(self, custom_config):
        """Test that register_mcp_provider respects override flag"""
        # Clear any existing custom providers
        MCPProviderRegistry._custom_providers = []

        # Register with override=True
        register_mcp_provider(custom_config, override=True)

        # Check override flag was stored
        assert MCPProviderRegistry._custom_providers[0][1] is True

    def test_custom_provider_registered_on_initialize(self, custom_config, monkeypatch):
        """Test that custom providers are registered during initialize()"""
        # Reset registry state
        monkeypatch.setattr(MCPProviderRegistry, "_providers", {})
        monkeypatch.setattr(MCPProviderRegistry, "_initialized", False)
        monkeypatch.setattr(
            MCPProviderRegistry, "_custom_providers", [(custom_config, False)]
        )

        # Initialize
        MCPProviderRegistry.initialize()

        # Check custom provider was registered
        assert "custom_test" in MCPProviderRegistry._providers
        assert (
            MCPProviderRegistry._providers["custom_test"].name == "Custom Test Provider"
        )


class TestRegistryIntegration:
    """Integration tests for the complete registry flow"""

    def test_initialize_loads_builtin_providers(self, monkeypatch):
        """Test that initialize() loads built-in providers"""
        # Reset state
        monkeypatch.setattr(MCPProviderRegistry, "_providers", {})
        monkeypatch.setattr(MCPProviderRegistry, "_initialized", False)
        monkeypatch.setattr(MCPProviderRegistry, "_custom_providers", [])

        MCPProviderRegistry.initialize()

        # Check built-in providers are loaded
        providers = MCPProviderRegistry.list_all()
        keys = [p.key for p in providers]

        assert "bailian" in keys
        assert "modelscope" in keys
        assert "mcp_router" in keys

    def test_initialize_loads_discovered_providers(self, monkeypatch):
        """Test that initialize() loads auto-discovered providers"""
        # Reset state
        monkeypatch.setattr(MCPProviderRegistry, "_providers", {})
        monkeypatch.setattr(MCPProviderRegistry, "_initialized", False)
        monkeypatch.setattr(MCPProviderRegistry, "_custom_providers", [])

        MCPProviderRegistry.initialize()

        # All discovered providers should be registered
        discovered_keys = {p.key for p in PROVIDER_CONFIGS}
        registered_keys = set(MCPProviderRegistry.list_keys())

        # All discovered providers should be in registry
        assert discovered_keys.issubset(registered_keys)

    def test_duplicate_registration_skipped_by_default(self, monkeypatch):
        """Test that duplicate provider keys are skipped by default"""
        # Create a config with same key as existing
        existing = MCPProviderRegistry.get("bailian")
        assert existing is not None

        # Try to register duplicate
        MCPProviderRegistry.register(existing)  # Should log warning and skip

        # Still only one bailian provider
        assert len([k for k in MCPProviderRegistry.list_keys() if k == "bailian"]) == 1

    def test_override_allows_replacement(self, monkeypatch):
        """Test that override=True allows replacing existing provider"""
        # Reset state
        monkeypatch.setattr(MCPProviderRegistry, "_providers", {})
        monkeypatch.setattr(MCPProviderRegistry, "_initialized", False)
        monkeypatch.setattr(MCPProviderRegistry, "_custom_providers", [])

        # First initialize with built-in providers
        MCPProviderRegistry.initialize()

        # Create modified version of bailian
        original = MCPProviderRegistry.get("bailian")
        modified = MCPProviderConfig(
            key="bailian",  # Same key
            name="阿里云百炼(Modified)",  # Modified name
            name_en=original.name_en,
            description=original.description,
            discover_url=original.discover_url,
            api_key_url=original.api_key_url,
            token_field=original.token_field,
            api=original.api,
            mapping=original.mapping,
            server=original.server,
        )

        # Register with override
        MCPProviderRegistry.register(modified, override=True)

        # Check it was replaced
        current = MCPProviderRegistry.get("bailian")
        assert current.name == "阿里云百炼(Modified)"


class TestPublicAPI:
    """Test public API functions"""

    def test_get_mcp_provider(self):
        """Test get_mcp_provider function"""
        provider = get_mcp_provider("bailian")
        assert provider is not None
        assert provider.key == "bailian"
        assert provider.name == "阿里云百炼"

    def test_get_mcp_provider_not_found(self):
        """Test get_mcp_provider returns None for unknown key"""
        provider = get_mcp_provider("nonexistent")
        assert provider is None

    def test_list_mcp_providers(self):
        """Test list_mcp_providers function"""
        providers = list_mcp_providers()
        assert isinstance(providers, list)
        assert len(providers) > 0

        # All items should be MCPProviderConfig
        for p in providers:
            assert isinstance(p, MCPProviderConfig)
