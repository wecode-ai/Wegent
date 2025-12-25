# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Tool service for managing tools and tool secrets
"""
import json
import logging
from typing import Any, Dict, List, Optional, Tuple

from shared.utils.crypto import decrypt_sensitive_data, encrypt_sensitive_data
from sqlalchemy import and_, or_
from sqlalchemy.orm import Session

from app.core.exceptions import ConflictException, NotFoundException
from app.db.session import SessionLocal
from app.models.kind import Kind
from app.models.tool import Tool
from app.models.tool_secret import ToolSecret
from app.schemas.tool import (
    GhostToolDetail,
    GhostToolRef,
    MCPConfig,
    ToolCreate,
    ToolInDB,
    ToolMarketItem,
    ToolStatus,
    ToolType,
    ToolUpdate,
    ToolVisibility,
)

logger = logging.getLogger(__name__)

# Predefined tool categories
TOOL_CATEGORIES = [
    "development",
    "database",
    "network",
    "storage",
    "communication",
    "productivity",
    "ai",
    "other",
]


class ToolService:
    """Service for Tool operations"""

    def get_db(self) -> Session:
        """Get database session"""
        return SessionLocal()

    # ========================================================================
    # Tool CRUD operations
    # ========================================================================

    def create_tool(self, db: Session, user_id: int, tool_create: ToolCreate) -> Tool:
        """Create a new tool"""
        # Check if tool with same name already exists for this user
        existing = (
            db.query(Tool)
            .filter(
                Tool.user_id == user_id,
                Tool.name == tool_create.name,
                Tool.is_active == True,
            )
            .first()
        )

        if existing:
            raise ConflictException(f"Tool '{tool_create.name}' already exists")

        # Validate tool configuration
        if tool_create.type == ToolType.MCP and not tool_create.mcp_config:
            raise ValueError("mcp_config is required for MCP type tools")
        if tool_create.type == ToolType.BUILTIN and not tool_create.builtin_config:
            raise ValueError("builtin_config is required for builtin type tools")

        tool = Tool(
            name=tool_create.name,
            type=tool_create.type.value,
            visibility=tool_create.visibility.value,
            category=tool_create.category,
            tags=tool_create.tags,
            description=tool_create.description,
            mcp_config=tool_create.mcp_config.model_dump() if tool_create.mcp_config else None,
            builtin_config=tool_create.builtin_config.model_dump() if tool_create.builtin_config else None,
            user_id=user_id,
        )

        db.add(tool)
        db.commit()
        db.refresh(tool)

        logger.info(f"Created tool: name={tool.name}, user_id={user_id}")
        return tool

    def get_tool(self, db: Session, tool_id: int) -> Optional[Tool]:
        """Get tool by ID"""
        return (
            db.query(Tool)
            .filter(Tool.id == tool_id, Tool.is_active == True)
            .first()
        )

    def get_tool_by_name(
        self, db: Session, user_id: int, name: str
    ) -> Optional[Tool]:
        """Get tool by name for a user (including public tools)"""
        # First try user's own tools
        tool = (
            db.query(Tool)
            .filter(
                Tool.user_id == user_id,
                Tool.name == name,
                Tool.is_active == True,
            )
            .first()
        )

        if tool:
            return tool

        # Then try public tools
        return (
            db.query(Tool)
            .filter(
                Tool.visibility == ToolVisibility.PUBLIC.value,
                Tool.name == name,
                Tool.is_active == True,
            )
            .first()
        )

    def list_tools(
        self,
        db: Session,
        user_id: int,
        visibility: Optional[str] = None,
        category: Optional[str] = None,
        tool_type: Optional[str] = None,
        skip: int = 0,
        limit: int = 100,
    ) -> Tuple[List[Tool], int]:
        """List tools for a user (personal + public)"""
        query = db.query(Tool).filter(
            Tool.is_active == True,
            or_(
                Tool.user_id == user_id,
                Tool.visibility == ToolVisibility.PUBLIC.value,
            ),
        )

        if visibility:
            query = query.filter(Tool.visibility == visibility)

        if category:
            query = query.filter(Tool.category == category)

        if tool_type:
            query = query.filter(Tool.type == tool_type)

        total = query.count()
        tools = query.offset(skip).limit(limit).all()

        return tools, total

    def list_market_tools(
        self,
        db: Session,
        category: Optional[str] = None,
        tags: Optional[List[str]] = None,
        search: Optional[str] = None,
        skip: int = 0,
        limit: int = 100,
    ) -> Tuple[List[Tool], int, List[str]]:
        """List public tools in the market"""
        query = db.query(Tool).filter(
            Tool.is_active == True,
            Tool.visibility == ToolVisibility.PUBLIC.value,
        )

        if category:
            query = query.filter(Tool.category == category)

        if search:
            query = query.filter(
                or_(
                    Tool.name.ilike(f"%{search}%"),
                    Tool.description.ilike(f"%{search}%"),
                )
            )

        # TODO: Add tags filtering with JSON contains

        total = query.count()
        tools = query.offset(skip).limit(limit).all()

        # Get distinct categories
        categories = (
            db.query(Tool.category)
            .filter(
                Tool.is_active == True,
                Tool.visibility == ToolVisibility.PUBLIC.value,
                Tool.category.isnot(None),
            )
            .distinct()
            .all()
        )
        category_list = [c[0] for c in categories if c[0]]

        return tools, total, category_list

    def update_tool(
        self, db: Session, user_id: int, tool_id: int, tool_update: ToolUpdate
    ) -> Tool:
        """Update a tool"""
        tool = (
            db.query(Tool)
            .filter(
                Tool.id == tool_id,
                Tool.user_id == user_id,
                Tool.is_active == True,
            )
            .first()
        )

        if not tool:
            raise NotFoundException(f"Tool with ID {tool_id} not found")

        # Update fields
        update_data = tool_update.model_dump(exclude_unset=True)

        for field, value in update_data.items():
            if field == "mcp_config" and value:
                setattr(tool, field, value.model_dump() if hasattr(value, "model_dump") else value)
            elif field == "builtin_config" and value:
                setattr(tool, field, value.model_dump() if hasattr(value, "model_dump") else value)
            elif field == "visibility" and value:
                setattr(tool, field, value.value if hasattr(value, "value") else value)
            else:
                setattr(tool, field, value)

        db.commit()
        db.refresh(tool)

        logger.info(f"Updated tool: id={tool_id}, user_id={user_id}")
        return tool

    def delete_tool(self, db: Session, user_id: int, tool_id: int) -> bool:
        """Soft delete a tool"""
        tool = (
            db.query(Tool)
            .filter(
                Tool.id == tool_id,
                Tool.user_id == user_id,
                Tool.is_active == True,
            )
            .first()
        )

        if not tool:
            raise NotFoundException(f"Tool with ID {tool_id} not found")

        tool.is_active = False
        db.commit()

        logger.info(f"Deleted tool: id={tool_id}, user_id={user_id}")
        return True

    def get_categories(self) -> List[str]:
        """Get all tool categories"""
        return TOOL_CATEGORIES

    # ========================================================================
    # Ghost Tool operations
    # ========================================================================

    def add_tool_to_ghost(
        self,
        db: Session,
        user_id: int,
        ghost_id: int,
        tool_name: str,
    ) -> Dict[str, Any]:
        """Add a tool to a Ghost"""
        # Get the Ghost
        ghost = (
            db.query(Kind)
            .filter(
                Kind.id == ghost_id,
                Kind.user_id == user_id,
                Kind.kind == "Ghost",
                Kind.is_active == True,
            )
            .first()
        )

        if not ghost:
            raise NotFoundException(f"Ghost with ID {ghost_id} not found")

        # Get the Tool
        tool = self.get_tool_by_name(db, user_id, tool_name)
        if not tool:
            raise NotFoundException(f"Tool '{tool_name}' not found")

        # Check if tool is already added
        ghost_json = ghost.json
        tools = ghost_json.get("spec", {}).get("tools", []) or []

        for t in tools:
            if t.get("toolRef") == tool_name:
                raise ConflictException(f"Tool '{tool_name}' is already added to this Ghost")

        # Determine initial status
        has_required_env = False
        if tool.mcp_config and tool.mcp_config.get("envSchema"):
            for env_item in tool.mcp_config.get("envSchema", []):
                if env_item.get("required"):
                    has_required_env = True
                    break

        status = ToolStatus.PENDING_CONFIG.value if has_required_env else ToolStatus.AVAILABLE.value

        # Add tool reference
        new_tool_ref = {"toolRef": tool_name, "status": status}
        tools.append(new_tool_ref)

        # Update Ghost
        if "spec" not in ghost_json:
            ghost_json["spec"] = {}
        ghost_json["spec"]["tools"] = tools

        ghost.json = ghost_json
        db.commit()

        logger.info(f"Added tool '{tool_name}' to Ghost {ghost_id}")
        return new_tool_ref

    def remove_tool_from_ghost(
        self,
        db: Session,
        user_id: int,
        ghost_id: int,
        tool_name: str,
    ) -> bool:
        """Remove a tool from a Ghost"""
        # Get the Ghost
        ghost = (
            db.query(Kind)
            .filter(
                Kind.id == ghost_id,
                Kind.user_id == user_id,
                Kind.kind == "Ghost",
                Kind.is_active == True,
            )
            .first()
        )

        if not ghost:
            raise NotFoundException(f"Ghost with ID {ghost_id} not found")

        # Get the Tool to find its ID
        tool = self.get_tool_by_name(db, user_id, tool_name)

        # Remove tool reference from Ghost
        ghost_json = ghost.json
        tools = ghost_json.get("spec", {}).get("tools", []) or []

        new_tools = [t for t in tools if t.get("toolRef") != tool_name]

        if len(new_tools) == len(tools):
            raise NotFoundException(f"Tool '{tool_name}' not found in Ghost")

        ghost_json["spec"]["tools"] = new_tools
        ghost.json = ghost_json

        # Also delete secrets if they exist
        if tool:
            db.query(ToolSecret).filter(
                ToolSecret.ghost_id == ghost_id,
                ToolSecret.tool_id == tool.id,
            ).delete()

        db.commit()

        logger.info(f"Removed tool '{tool_name}' from Ghost {ghost_id}")
        return True

    def update_tool_status_in_ghost(
        self,
        db: Session,
        user_id: int,
        ghost_id: int,
        tool_name: str,
        status: ToolStatus,
    ) -> Dict[str, Any]:
        """Update tool status in a Ghost"""
        # Get the Ghost
        ghost = (
            db.query(Kind)
            .filter(
                Kind.id == ghost_id,
                Kind.user_id == user_id,
                Kind.kind == "Ghost",
                Kind.is_active == True,
            )
            .first()
        )

        if not ghost:
            raise NotFoundException(f"Ghost with ID {ghost_id} not found")

        # Update tool status
        ghost_json = ghost.json
        tools = ghost_json.get("spec", {}).get("tools", []) or []

        tool_found = False
        for t in tools:
            if t.get("toolRef") == tool_name:
                t["status"] = status.value
                tool_found = True
                break

        if not tool_found:
            raise NotFoundException(f"Tool '{tool_name}' not found in Ghost")

        ghost_json["spec"]["tools"] = tools
        ghost.json = ghost_json
        db.commit()

        logger.info(f"Updated tool '{tool_name}' status to '{status.value}' in Ghost {ghost_id}")
        return {"toolRef": tool_name, "status": status.value}

    def list_tools_in_ghost(
        self,
        db: Session,
        user_id: int,
        ghost_id: int,
    ) -> List[GhostToolDetail]:
        """List all tools in a Ghost with details"""
        # Get the Ghost
        ghost = (
            db.query(Kind)
            .filter(
                Kind.id == ghost_id,
                Kind.user_id == user_id,
                Kind.kind == "Ghost",
                Kind.is_active == True,
            )
            .first()
        )

        if not ghost:
            raise NotFoundException(f"Ghost with ID {ghost_id} not found")

        ghost_json = ghost.json
        tools = ghost_json.get("spec", {}).get("tools", []) or []

        result = []
        for tool_ref in tools:
            tool_name = tool_ref.get("toolRef")
            status = tool_ref.get("status", ToolStatus.PENDING_CONFIG.value)

            # Get tool details
            tool = self.get_tool_by_name(db, user_id, tool_name)

            if tool:
                # Check if secrets are configured
                secret = (
                    db.query(ToolSecret)
                    .filter(
                        ToolSecret.ghost_id == ghost_id,
                        ToolSecret.tool_id == tool.id,
                    )
                    .first()
                )

                # Check if tool has secret env variables
                has_secrets = False
                if tool.mcp_config and tool.mcp_config.get("envSchema"):
                    for env_item in tool.mcp_config.get("envSchema", []):
                        if env_item.get("secret"):
                            has_secrets = True
                            break

                result.append(
                    GhostToolDetail(
                        tool_id=tool.id,
                        tool_name=tool_name,
                        status=ToolStatus(status),
                        tool=ToolMarketItem(
                            id=tool.id,
                            name=tool.name,
                            type=ToolType(tool.type),
                            category=tool.category,
                            tags=tool.tags,
                            description=tool.description,
                            mcp_config=MCPConfig(**tool.mcp_config) if tool.mcp_config else None,
                            builtin_config=tool.builtin_config,
                        ),
                        has_secrets=has_secrets,
                        secret_configured=secret is not None,
                    )
                )
            else:
                # Tool was deleted or not accessible
                result.append(
                    GhostToolDetail(
                        tool_id=0,
                        tool_name=tool_name,
                        status=ToolStatus(status),
                        tool=None,
                        has_secrets=False,
                        secret_configured=False,
                    )
                )

        return result

    # ========================================================================
    # Tool Secret operations
    # ========================================================================

    def set_tool_secrets(
        self,
        db: Session,
        user_id: int,
        ghost_id: int,
        tool_name: str,
        env_values: Dict[str, str],
    ) -> bool:
        """Set secret environment variables for a tool in a Ghost"""
        # Get the Ghost
        ghost = (
            db.query(Kind)
            .filter(
                Kind.id == ghost_id,
                Kind.user_id == user_id,
                Kind.kind == "Ghost",
                Kind.is_active == True,
            )
            .first()
        )

        if not ghost:
            raise NotFoundException(f"Ghost with ID {ghost_id} not found")

        # Verify tool is in Ghost
        ghost_json = ghost.json
        tools = ghost_json.get("spec", {}).get("tools", []) or []
        tool_in_ghost = None
        for t in tools:
            if t.get("toolRef") == tool_name:
                tool_in_ghost = t
                break

        if not tool_in_ghost:
            raise NotFoundException(f"Tool '{tool_name}' not found in Ghost")

        # Get the Tool
        tool = self.get_tool_by_name(db, user_id, tool_name)
        if not tool:
            raise NotFoundException(f"Tool '{tool_name}' not found")

        # Encrypt the environment values
        encrypted_env = {}
        for key, value in env_values.items():
            if value and value != "***":
                encrypted_env[key] = encrypt_sensitive_data(value)
            elif value == "***":
                # Keep existing value if masked
                existing = (
                    db.query(ToolSecret)
                    .filter(
                        ToolSecret.ghost_id == ghost_id,
                        ToolSecret.tool_id == tool.id,
                    )
                    .first()
                )
                if existing:
                    existing_env = json.loads(existing.encrypted_env)
                    if key in existing_env:
                        encrypted_env[key] = existing_env[key]
            else:
                encrypted_env[key] = ""

        # Update or create secret record
        existing_secret = (
            db.query(ToolSecret)
            .filter(
                ToolSecret.ghost_id == ghost_id,
                ToolSecret.tool_id == tool.id,
            )
            .first()
        )

        if existing_secret:
            existing_secret.encrypted_env = json.dumps(encrypted_env)
        else:
            new_secret = ToolSecret(
                ghost_id=ghost_id,
                tool_id=tool.id,
                encrypted_env=json.dumps(encrypted_env),
            )
            db.add(new_secret)

        # Update tool status to available if all required secrets are configured
        all_required_configured = True
        if tool.mcp_config and tool.mcp_config.get("envSchema"):
            for env_item in tool.mcp_config.get("envSchema", []):
                if env_item.get("required"):
                    env_name = env_item.get("name")
                    if env_name not in encrypted_env or not encrypted_env[env_name]:
                        all_required_configured = False
                        break

        if all_required_configured:
            tool_in_ghost["status"] = ToolStatus.AVAILABLE.value
            ghost_json["spec"]["tools"] = tools
            ghost.json = ghost_json

        db.commit()

        logger.info(f"Set secrets for tool '{tool_name}' in Ghost {ghost_id}")
        return True

    def get_tool_secrets(
        self,
        db: Session,
        user_id: int,
        ghost_id: int,
        tool_name: str,
        masked: bool = True,
    ) -> Dict[str, str]:
        """Get secret environment variables for a tool in a Ghost"""
        # Get the Ghost
        ghost = (
            db.query(Kind)
            .filter(
                Kind.id == ghost_id,
                Kind.user_id == user_id,
                Kind.kind == "Ghost",
                Kind.is_active == True,
            )
            .first()
        )

        if not ghost:
            raise NotFoundException(f"Ghost with ID {ghost_id} not found")

        # Get the Tool
        tool = self.get_tool_by_name(db, user_id, tool_name)
        if not tool:
            raise NotFoundException(f"Tool '{tool_name}' not found")

        # Get secret record
        secret = (
            db.query(ToolSecret)
            .filter(
                ToolSecret.ghost_id == ghost_id,
                ToolSecret.tool_id == tool.id,
            )
            .first()
        )

        if not secret:
            return {}

        encrypted_env = json.loads(secret.encrypted_env)

        if masked:
            # Return masked values
            result = {}
            for key, value in encrypted_env.items():
                if value:
                    result[key] = "***"
                else:
                    result[key] = ""
            return result
        else:
            # Return decrypted values
            result = {}
            for key, value in encrypted_env.items():
                if value:
                    result[key] = decrypt_sensitive_data(value)
                else:
                    result[key] = ""
            return result

    def get_tool_config_for_executor(
        self,
        db: Session,
        user_id: int,
        ghost_id: int,
    ) -> Dict[str, Any]:
        """Get complete tool configuration for executor (including decrypted secrets)"""
        # Get the Ghost
        ghost = (
            db.query(Kind)
            .filter(
                Kind.id == ghost_id,
                Kind.user_id == user_id,
                Kind.kind == "Ghost",
                Kind.is_active == True,
            )
            .first()
        )

        if not ghost:
            raise NotFoundException(f"Ghost with ID {ghost_id} not found")

        ghost_json = ghost.json
        tools = ghost_json.get("spec", {}).get("tools", []) or []

        mcp_servers = {}

        for tool_ref in tools:
            tool_name = tool_ref.get("toolRef")
            status = tool_ref.get("status", ToolStatus.PENDING_CONFIG.value)

            # Only include available tools
            if status != ToolStatus.AVAILABLE.value:
                continue

            # Get tool details
            tool = self.get_tool_by_name(db, user_id, tool_name)
            if not tool or tool.type != ToolType.MCP.value:
                continue

            if not tool.mcp_config:
                continue

            # Get secrets
            secrets = self.get_tool_secrets(
                db, user_id, ghost_id, tool_name, masked=False
            )

            # Build MCP server config
            mcp_config = tool.mcp_config.copy()
            mcp_server = {
                "name": tool_name,
                "serverType": mcp_config.get("serverType"),
                "args": mcp_config.get("args", []),
                "env": secrets,
            }

            if mcp_config.get("url"):
                mcp_server["url"] = mcp_config.get("url")

            mcp_servers[tool_name] = mcp_server

        return mcp_servers


# Create service instance
tool_service = ToolService()
