# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator

MCPInstallState = Literal[
    "not_installed",
    "installed",
    "update_available",
    "unavailable",
    "failed",
    "uninstalled",
]


class InstalledMCPServerConfig(BaseModel):
    """MCP server configuration stored for an installed MCP."""

    type: Literal["streamable-http", "sse", "stdio", "http"] = "streamable-http"
    url: Optional[str] = None
    base_url: Optional[str] = None
    command: Optional[str] = None
    args: Optional[List[str]] = None
    env: Optional[Dict[str, str]] = None
    headers: Optional[Dict[str, str]] = None


class InstalledMCPSource(BaseModel):
    """Source identity for an installed MCP."""

    type: Literal["custom", "provider"]
    providerKey: Optional[str] = None
    serverKey: str
    catalogItemId: Optional[str] = None


class InstalledMCPSpec(BaseModel):
    """User-scoped MCP installation and configuration state."""

    source: InstalledMCPSource
    displayName: str
    description: str = ""
    server: InstalledMCPServerConfig
    installState: MCPInstallState = "installed"
    enabled: bool = True
    sourcePayload: Optional[Dict[str, Any]] = None


class InstalledMCPStatus(BaseModel):
    """Runtime status for an InstalledMCP CRD."""

    state: str = "Available"


class InstalledMCP(BaseModel):
    """InstalledMCP CRD stored in the existing kinds table."""

    model_config = ConfigDict(populate_by_name=True)

    apiVersion: str = "agent.wecode.io/v1"
    kind: Literal["InstalledMCP"] = "InstalledMCP"
    metadata: Dict[str, Any]
    spec: InstalledMCPSpec
    status: InstalledMCPStatus = Field(default_factory=InstalledMCPStatus)


class InstalledMCPListResponse(BaseModel):
    """Response for listing user-installed MCPs."""

    items: List[InstalledMCP]


class InstalledMCPCustomCreateRequest(BaseModel):
    """Request to create a user-defined MCP installation."""

    name: str
    displayName: str
    description: str = ""
    server: InstalledMCPServerConfig
    enabled: bool = True

    @field_validator("name")
    @classmethod
    def validate_name(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("name is required")
        return cleaned


class InstalledMCPInstallRequest(BaseModel):
    """Request to install an MCP server from a provider catalog."""

    providerKey: str
    serverKey: str
    catalogItemId: Optional[str] = None
    displayName: str
    description: str = ""
    server: InstalledMCPServerConfig
    sourcePayload: Optional[Dict[str, Any]] = None


class InstalledMCPUpdateRequest(BaseModel):
    """Request to update an installed MCP."""

    enabled: Optional[bool] = None
    displayName: Optional[str] = None
    description: Optional[str] = None
    server: Optional[InstalledMCPServerConfig] = None


class MCPInstallCatalogItem(BaseModel):
    """Provider-normalized MCP catalog item with user install state."""

    id: str
    providerKey: str
    serverKey: str
    name: str
    description: Optional[str] = None
    server: InstalledMCPServerConfig
    providerName: Optional[str] = None
    providerUrl: Optional[str] = None
    logoUrl: Optional[str] = None
    tags: List[str] = Field(default_factory=list)
    installState: MCPInstallState = "not_installed"
    installedMcpId: Optional[int] = None
    enabled: bool = False
