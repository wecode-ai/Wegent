# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Registry for user-scoped MCP provider integrations."""

from __future__ import annotations

from typing import TypedDict


class MCPProviderServiceDefinition(TypedDict):
    """Static definition for a provider MCP service."""

    service_id: str
    server_name: str
    detail_url: str


class MCPProviderDefinition(TypedDict):
    """Static definition for a provider and its supported MCP services."""

    provider_id: str
    guidance_skill: str | None
    message_keywords: tuple[str, ...]
    services: dict[str, MCPProviderServiceDefinition]


MCP_PROVIDER_REGISTRY: dict[str, MCPProviderDefinition] = {
    "dingtalk": {
        "provider_id": "dingtalk",
        "guidance_skill": "dingtalk-config-guide",
        "message_keywords": ("钉钉", "dingtalk"),
        "services": {
            "docs": {
                "service_id": "docs",
                "server_name": "dingtalk_docs",
                "detail_url": "https://mcp.dingtalk.com/#/detail?mcpId=9629",
            },
            "ai_table": {
                "service_id": "ai_table",
                "server_name": "dingtalk_ai_table",
                "detail_url": "https://mcp.dingtalk.com/#/detail?mcpId=9555",
            },
        },
    }
}


def list_mcp_providers() -> list[MCPProviderDefinition]:
    """Return all registered MCP providers."""
    return list(MCP_PROVIDER_REGISTRY.values())


def get_mcp_provider(provider_id: str) -> MCPProviderDefinition | None:
    """Look up an MCP provider by id."""
    return MCP_PROVIDER_REGISTRY.get(provider_id)


def list_mcp_provider_services(provider_id: str) -> list[MCPProviderServiceDefinition]:
    """Return all services registered for a provider."""
    provider = get_mcp_provider(provider_id)
    if not provider:
        return []

    return list(provider["services"].values())


def get_mcp_provider_service(
    provider_id: str, service_id: str
) -> MCPProviderServiceDefinition | None:
    """Look up a provider MCP service by provider id and service id."""
    provider = get_mcp_provider(provider_id)
    if not provider:
        return None

    return provider["services"].get(service_id)
