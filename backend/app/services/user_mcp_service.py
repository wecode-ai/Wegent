# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""User-level MCP configuration helpers."""

from __future__ import annotations

import json
from typing import Any

from app.services.mcp_provider_registry import (
    get_mcp_provider,
    get_mcp_provider_service,
    list_mcp_provider_services,
    list_mcp_providers,
)
from shared.utils.crypto import (
    decrypt_sensitive_data,
    encrypt_sensitive_data,
    is_data_encrypted,
)

MCP_ROOT_KEY = "mcps"
MCP_SERVICES_KEY = "services"
MCP_CREDENTIALS_KEY = "credentials"
MCP_URL_KEY = "url"


class UserMCPService:
    """Helper service for reading and writing user-scoped MCP settings."""

    @staticmethod
    def load_preferences(preferences: str | dict[str, Any] | None) -> dict[str, Any]:
        """Parse raw preferences payload into a dictionary."""
        if not preferences:
            return {}

        if isinstance(preferences, dict):
            return dict(preferences)

        try:
            parsed = json.loads(preferences)
            return parsed if isinstance(parsed, dict) else {}
        except (TypeError, json.JSONDecodeError):
            return {}

    @staticmethod
    def dump_preferences(preferences: dict[str, Any]) -> str:
        """Serialize preferences for persistence."""
        return json.dumps(preferences)

    @staticmethod
    def get_provider_service_config(
        preferences: str | dict[str, Any] | None,
        provider_id: str,
        service_id: str,
    ) -> dict[str, Any]:
        """Get a decrypted provider MCP service config from user preferences."""
        prefs = UserMCPService.load_preferences(preferences)
        provider = ((prefs.get(MCP_ROOT_KEY) or {}).get(provider_id) or {}).copy()
        services = (provider.get(MCP_SERVICES_KEY) or {}).copy()
        service = (services.get(service_id) or {}).copy()
        credentials = (service.get(MCP_CREDENTIALS_KEY) or {}).copy()

        url = credentials.get(MCP_URL_KEY, "")

        if isinstance(url, str) and url:
            if is_data_encrypted(url):
                decrypted = decrypt_sensitive_data(url)
                url = decrypted or ""
        else:
            url = ""

        return {
            "enabled": bool(service.get("enabled", False)),
            "url": url,
        }

    @staticmethod
    def list_provider_service_configs(
        preferences: str | dict[str, Any] | None,
        provider_id: str,
    ) -> list[dict[str, Any]]:
        """Return all registered provider services merged with user config."""
        configs = []
        for service in list_mcp_provider_services(provider_id):
            config = UserMCPService.get_provider_service_config(
                preferences, provider_id, service["service_id"]
            )
            configs.append({"provider_id": provider_id, **service, **config})
        return configs

    @staticmethod
    def set_provider_service_config(
        preferences: str | dict[str, Any] | None,
        *,
        provider_id: str,
        service_id: str,
        enabled: bool,
        url: str,
    ) -> dict[str, Any]:
        """Update a provider MCP service config inside user preferences."""
        if not get_mcp_provider_service(provider_id, service_id):
            raise ValueError(
                f"Unsupported MCP provider service: {provider_id}/{service_id}"
            )

        prefs = UserMCPService.load_preferences(preferences)
        mcps = dict(prefs.get(MCP_ROOT_KEY) or {})
        provider = dict(mcps.get(provider_id) or {})
        services = dict(provider.get(MCP_SERVICES_KEY) or {})
        service = dict(services.get(service_id) or {})
        credentials = dict(service.get(MCP_CREDENTIALS_KEY) or {})

        cleaned_url = url.strip()
        if cleaned_url:
            credentials[MCP_URL_KEY] = (
                cleaned_url
                if is_data_encrypted(cleaned_url)
                else encrypt_sensitive_data(cleaned_url)
            )
        else:
            credentials.pop(MCP_URL_KEY, None)

        service["enabled"] = enabled
        if credentials:
            service[MCP_CREDENTIALS_KEY] = credentials
        else:
            service.pop(MCP_CREDENTIALS_KEY, None)

        services[service_id] = service
        provider[MCP_SERVICES_KEY] = services

        mcps[provider_id] = provider
        prefs[MCP_ROOT_KEY] = mcps
        return prefs

    @staticmethod
    def list_mcp_servers(
        preferences: str | dict[str, Any] | None,
        provider_id: str | None = None,
    ) -> list[dict[str, Any]]:
        """Build MCP server configs for enabled services across providers."""
        servers = []
        provider_ids = (
            [provider_id]
            if provider_id
            else [provider["provider_id"] for provider in list_mcp_providers()]
        )
        for current_provider_id in provider_ids:
            if not get_mcp_provider(current_provider_id):
                continue

            for service in UserMCPService.list_provider_service_configs(
                preferences, current_provider_id
            ):
                url = (service.get("url") or "").strip()
                if not service.get("enabled") or not url:
                    continue

                servers.append(
                    {
                        "name": service["server_name"],
                        "url": url,
                        "type": "streamable-http",
                    }
                )

        return servers


user_mcp_service = UserMCPService()
