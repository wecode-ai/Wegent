# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from typing import Any, Dict, List, Optional

from pydantic import BaseModel


class MCPServer(BaseModel):
    """MCP Server definition"""

    id: str  # Provider-prefixed ID: @bailian/{id}
    name: str  # Display name
    description: Optional[str] = None
    type: str  # "streamable-http" | "sse"
    base_url: Optional[str] = None  # Server URL
    command: Optional[str] = None  # For stdio type
    args: Optional[List[str]] = None  # Command arguments
    env: Optional[Dict[str, str]] = None  # Environment variables
    headers: Optional[Dict[str, str]] = None  # HTTP headers (auth)
    is_active: bool = True
    provider: str  # Provider name
    provider_url: Optional[str] = None
    logo_url: Optional[str] = None
    tags: Optional[List[str]] = None


class MCPProviderInfo(BaseModel):
    """MCP Provider metadata"""

    key: str
    name: str
    name_en: Optional[str] = None
    description: str
    discover_url: str
    api_key_url: str
    token_field_name: str
    has_token: bool = False  # Whether user has configured token


class MCPProviderListResponse(BaseModel):
    """Response for listing providers"""

    providers: List[MCPProviderInfo]


class MCPServerListResponse(BaseModel):
    """Response for listing servers"""

    success: bool
    message: str
    servers: List[MCPServer]
    error_details: Optional[str] = None


class MCPProviderKeysRequest(BaseModel):
    """Request to update MCP provider API keys"""

    bailian: Optional[str] = None
    modelscope: Optional[str] = None
    mcp_router: Optional[str] = None


class MCPProviderKeysResponse(BaseModel):
    """Response for MCP provider keys update"""

    success: bool
    message: str
