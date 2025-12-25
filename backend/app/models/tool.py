# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Tool model for managing MCP servers and builtin tools
"""
from datetime import datetime
from enum import Enum as PyEnum

from sqlalchemy import (
    JSON,
    Boolean,
    Column,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import relationship

from app.db.base import Base


class ToolType(str, PyEnum):
    """Tool type enumeration"""

    MCP = "mcp"
    BUILTIN = "builtin"


class ToolVisibility(str, PyEnum):
    """Tool visibility enumeration"""

    PERSONAL = "personal"
    TEAM = "team"
    PUBLIC = "public"


class Tool(Base):
    """Tool model for managing MCP servers and builtin tools"""

    __tablename__ = "tools"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(255), nullable=False, index=True)
    namespace = Column(String(255), default="default")

    # CRD spec fields
    type = Column(String(50), nullable=False)  # mcp, builtin
    visibility = Column(String(50), default="personal")  # personal, team, public
    category = Column(String(100))
    tags = Column(JSON)  # ["tag1", "tag2"]
    description = Column(Text)

    # MCP config (JSON) - serverType, args, envSchema
    mcp_config = Column(JSON)

    # Builtin config (JSON) - toolId
    builtin_config = Column(JSON)

    # Ownership
    user_id = Column(Integer, nullable=False, index=True)

    # Audit
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.now)
    updated_at = Column(DateTime, default=datetime.now, onupdate=datetime.now)

    __table_args__ = (
        Index("idx_tool_user_name", "user_id", "name"),
        Index("idx_tool_visibility", "visibility"),
        Index("idx_tool_type", "type"),
        {
            "sqlite_autoincrement": True,
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
            "comment": "Tool definitions for MCP servers and builtin tools",
        },
    )
