# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Tool schemas for API requests and responses
"""
from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class ToolType(str, Enum):
    """Tool type enumeration"""

    MCP = "mcp"
    BUILTIN = "builtin"


class ToolVisibility(str, Enum):
    """Tool visibility enumeration"""

    PERSONAL = "personal"
    TEAM = "team"
    PUBLIC = "public"


class ToolStatus(str, Enum):
    """Tool status in Ghost"""

    AVAILABLE = "available"
    PENDING_CONFIG = "pending_config"
    DISABLED = "disabled"


class EnvSchemaItem(BaseModel):
    """Environment variable schema definition"""

    name: str = Field(..., description="Environment variable name")
    displayName: Optional[str] = Field(None, description="Human-readable display name")
    description: Optional[str] = Field(None, description="Description of the variable")
    required: bool = Field(False, description="Whether the variable is required")
    secret: bool = Field(False, description="Whether the value is sensitive and should be encrypted")
    default: Optional[str] = Field(None, description="Default value")


class MCPConfig(BaseModel):
    """MCP server configuration"""

    serverType: str = Field(..., description="Server type: stdio | sse | streamable-http")
    args: Optional[List[str]] = Field(None, description="Command arguments for stdio type")
    url: Optional[str] = Field(None, description="Server URL for sse/streamable-http types")
    envSchema: Optional[List[EnvSchemaItem]] = Field(
        None, description="Environment variable schema definitions"
    )


class BuiltinConfig(BaseModel):
    """Builtin tool configuration"""

    toolId: str = Field(..., description="System builtin tool identifier")


# Request schemas
class ToolBase(BaseModel):
    """Base tool schema"""

    name: str = Field(..., min_length=1, max_length=255, description="Tool name")
    type: ToolType = Field(..., description="Tool type: mcp | builtin")
    visibility: ToolVisibility = Field(
        ToolVisibility.PERSONAL, description="Tool visibility: personal | team | public"
    )
    category: Optional[str] = Field(None, max_length=100, description="Tool category")
    tags: Optional[List[str]] = Field(None, description="Tool tags")
    description: Optional[str] = Field(None, description="Tool description")
    mcp_config: Optional[MCPConfig] = Field(None, description="MCP configuration (required for mcp type)")
    builtin_config: Optional[BuiltinConfig] = Field(
        None, description="Builtin configuration (required for builtin type)"
    )


class ToolCreate(ToolBase):
    """Tool creation request schema"""

    pass


class ToolUpdate(BaseModel):
    """Tool update request schema"""

    name: Optional[str] = Field(None, min_length=1, max_length=255)
    visibility: Optional[ToolVisibility] = None
    category: Optional[str] = Field(None, max_length=100)
    tags: Optional[List[str]] = None
    description: Optional[str] = None
    mcp_config: Optional[MCPConfig] = None
    builtin_config: Optional[BuiltinConfig] = None


class ToolInDB(ToolBase):
    """Tool response schema"""

    id: int
    user_id: int
    namespace: str = "default"
    is_active: bool = True
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class ToolListResponse(BaseModel):
    """Tool list response"""

    total: int
    items: List[ToolInDB]


class ToolMarketItem(BaseModel):
    """Tool market item for display"""

    id: int
    name: str
    type: ToolType
    category: Optional[str] = None
    tags: Optional[List[str]] = None
    description: Optional[str] = None
    mcp_config: Optional[MCPConfig] = None
    builtin_config: Optional[BuiltinConfig] = None

    class Config:
        from_attributes = True


class ToolMarketListResponse(BaseModel):
    """Tool market list response"""

    total: int
    items: List[ToolMarketItem]
    categories: List[str]


# Ghost Tool reference schemas
class GhostToolRef(BaseModel):
    """Reference to a Tool in Ghost"""

    toolRef: str = Field(..., description="Tool name reference")
    status: ToolStatus = Field(
        ToolStatus.PENDING_CONFIG, description="Tool status in this Ghost"
    )


class GhostToolSecretUpdate(BaseModel):
    """Update secrets for a Tool in Ghost"""

    env: Dict[str, str] = Field(..., description="Environment variable values")


class GhostToolSecretResponse(BaseModel):
    """Secret configuration response (with masked values)"""

    env: Dict[str, str] = Field(
        ..., description="Environment variable values (sensitive values masked)"
    )


class GhostToolDetail(BaseModel):
    """Detailed Tool information in Ghost context"""

    tool_id: int
    tool_name: str
    status: ToolStatus
    tool: Optional[ToolMarketItem] = None
    has_secrets: bool = False
    secret_configured: bool = False


# Category response
class ToolCategoryResponse(BaseModel):
    """Tool categories response"""

    categories: List[str]
