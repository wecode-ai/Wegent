# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import os
from typing import List, Optional

import httpx

from app.schemas.mcp_providers import MCPProviderInfo, MCPServer
from app.schemas.user import UserPreferences
from app.services.mcp_providers.core.registry import MCPProviderRegistry
from app.services.mcp_providers.security import decrypt_mcp_provider_key
from shared.logger import setup_logger

# Initialize registry on module load
MCPProviderRegistry.initialize()


class MCPProviderService:
    """Service for managing MCP providers"""

    logger = setup_logger("services.mcp_providers")

    @staticmethod
    def _has_proxy_env() -> bool:
        for key in (
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "ALL_PROXY",
            "http_proxy",
            "https_proxy",
            "all_proxy",
        ):
            if os.environ.get(key):
                return True
        return False

    @staticmethod
    def list_providers(preferences: Optional[UserPreferences]) -> List[MCPProviderInfo]:
        """List all available MCP providers with user's token status"""
        provider_keys = preferences.mcp_provider_keys if preferences else None

        result = []
        for provider_config in MCPProviderRegistry.list_all():
            has_token = False
            if provider_keys:
                encrypted_token = getattr(
                    provider_keys, provider_config.token_field, None
                )
                try:
                    has_token = bool(decrypt_mcp_provider_key(encrypted_token))
                except ValueError:
                    has_token = False

            result.append(
                MCPProviderInfo(
                    key=provider_config.key,
                    name=provider_config.name,
                    name_en=provider_config.name_en,
                    description=provider_config.description,
                    discover_url=provider_config.discover_url,
                    api_key_url=provider_config.api_key_url,
                    token_field_name=provider_config.token_field,
                    has_token=has_token,
                )
            )
        return result

    @staticmethod
    async def sync_servers(
        provider_key: str, preferences: Optional[UserPreferences]
    ) -> tuple[bool, str, List[MCPServer], Optional[str]]:
        """Sync MCP servers from a provider"""
        # Get provider config
        provider_config = MCPProviderRegistry.get(provider_key)
        if not provider_config:
            return False, f"Unknown provider: {provider_key}", [], None

        # Get token from preferences
        if not preferences or not preferences.mcp_provider_keys:
            return False, "API key not configured", [], None

        encrypted_token = getattr(
            preferences.mcp_provider_keys, provider_config.token_field, None
        )
        if not encrypted_token:
            return False, "API key not configured", [], None

        try:
            token = decrypt_mcp_provider_key(encrypted_token)
        except ValueError:
            return (
                False,
                "API key format is invalid. Please save the API key again.",
                [],
                "invalid_api_key_format",
            )

        MCPProviderService.logger.info(
            "Syncing MCP servers: provider_key=%s token_present=%s token_length=%s",
            provider_key,
            True,
            len(token),
        )

        # Call provider's sync function via registry
        try:
            servers, error = await MCPProviderRegistry.sync_servers(provider_key, token)
            if error:
                # Handle specific error codes from registry
                if error == "unauthorized":
                    return (
                        False,
                        "Authentication failed. Please check your API key.",
                        [],
                        "unauthorized",
                    )
                elif error == "server_error":
                    return (
                        False,
                        "Provider server error. Please try again later.",
                        [],
                        "server_error",
                    )
                elif error == "proxy_error":
                    return (
                        False,
                        "Proxy error while connecting to provider. Please check HTTP(S)_PROXY.",
                        [],
                        "proxy_error",
                    )
                elif error == "timeout":
                    return (
                        False,
                        "Provider request timed out. Please try again later.",
                        [],
                        "timeout",
                    )
                elif error == "connect_error":
                    return (
                        False,
                        "Network error while connecting to provider. Please check network/proxy settings.",
                        [],
                        "connect_error",
                    )
                else:
                    return False, f"Failed to sync servers: {error}", [], error

            MCPProviderService.logger.info(
                "Syncing MCP servers succeeded: provider_key=%s servers=%s",
                provider_key,
                len(servers),
            )
            return True, f"Successfully synced {len(servers)} servers", servers, None
        except httpx.ProxyError as e:
            MCPProviderService.logger.warning(
                "Syncing MCP servers proxy error: provider_key=%s proxy_env_present=%s error=%s",
                provider_key,
                MCPProviderService._has_proxy_env(),
                str(e) or type(e).__name__,
            )
            return (
                False,
                "Proxy error while connecting to provider. Please check HTTP(S)_PROXY.",
                [],
                "proxy_error",
            )
        except httpx.TimeoutException as e:
            MCPProviderService.logger.warning(
                "Syncing MCP servers timeout: provider_key=%s error=%s",
                provider_key,
                str(e) or type(e).__name__,
            )
            return (
                False,
                "Provider request timed out. Please try again later.",
                [],
                "timeout",
            )
        except httpx.ConnectError as e:
            MCPProviderService.logger.warning(
                "Syncing MCP servers connect error: provider_key=%s proxy_env_present=%s error=%s",
                provider_key,
                MCPProviderService._has_proxy_env(),
                str(e) or type(e).__name__,
            )
            return (
                False,
                "Network error while connecting to provider. Please check network/proxy settings.",
                [],
                "connect_error",
            )
        except httpx.HTTPError as e:
            MCPProviderService.logger.warning(
                "Syncing MCP servers httpx error: provider_key=%s error=%s",
                provider_key,
                str(e) or type(e).__name__,
            )
            return False, "Failed to sync servers", [], "http_error"
        except Exception as e:
            error_details = str(e) or type(e).__name__
            MCPProviderService.logger.exception(
                "Syncing MCP servers failed unexpectedly: provider_key=%s error_details=%s",
                provider_key,
                error_details,
            )
            return False, "Failed to sync servers", [], error_details
