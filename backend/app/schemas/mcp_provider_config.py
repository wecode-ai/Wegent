# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2-0

"""
MCP Provider Configuration Models

This module defines the declarative configuration models for MCP providers.
Instead of writing code for each provider, we use configuration-driven approach.
"""

from typing import Any, Dict, Literal, Optional

from pydantic import BaseModel, ConfigDict


class ProviderAPIConfig(BaseModel):
    """Provider API configuration"""

    model_config = ConfigDict(extra="allow")

    base_url: str  # API base URL
    list_path: str  # Server list API path
    method: Literal["GET", "POST"] = "GET"  # HTTP method
    query_params: Optional[Dict[str, Any]] = None  # Fixed query parameters
    headers: Optional[Dict[str, Any]] = None  # Fixed request headers
    auth_template: str = "Bearer {token}"  # Auth header template
    timeout: float = 30.0  # Timeout in seconds


class ResponseMappingConfig(BaseModel):
    """Response data mapping configuration"""

    model_config = ConfigDict(extra="allow")

    items_path: str = "data"  # Server list path (supports nested: "data.result")
    total_path: Optional[str] = "total"  # Total count path (for pagination)
    page_param: str = "pageNo"  # Page number param name
    size_param: str = "pageSize"  # Page size param name
    page_size: int = 20  # Default page size
    success_field: Optional[str] = "success"  # API success indicator field
    error_message_field: Optional[str] = "message"  # Error message field


class ServerMappingConfig(BaseModel):
    """Server field mapping configuration"""

    model_config = ConfigDict(extra="allow")

    id_field: str = "id"  # ID field
    name_field: str = "name"  # Name field
    description_field: Optional[str] = "description"  # Description field
    url_field: str = "operationalUrl"  # URL field (supports: "operational_urls[0].url")
    type_field: str = "type"  # Type field
    type_default: str = "streamable-http"  # Default type
    provider_field: Optional[str] = "provider"  # Provider name field
    provider_static: Optional[str] = None  # Static provider name
    active_field: Optional[str] = "active"  # Active status field
    logo_field: Optional[str] = "logo_url"  # Logo field
    tags_field: Optional[str] = "tags"  # Tags field
    id_prefix: str = ""  # ID prefix (e.g., "@bailian/")
    url_fallback: Optional[str] = None  # Fallback URL field if primary not found
    name_fallback: Optional[str] = None  # Fallback name field


class MCPProviderConfig(BaseModel):
    """Complete MCP Provider configuration"""

    model_config = ConfigDict(extra="allow")

    key: str  # Unique identifier
    name: str  # Display name
    name_en: str  # English display name
    description: str  # Description
    discover_url: str  # URL to provider's MCP marketplace
    api_key_url: str  # URL to get API key
    token_field: str  # Field name in preferences
    requires_token: bool = True  # Whether user needs to configure API key
    priority: int = 100  # Display priority (lower = first)

    api: ProviderAPIConfig
    mapping: ResponseMappingConfig
    server: ServerMappingConfig
