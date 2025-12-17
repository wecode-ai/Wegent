# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import logging
import re
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.models.kind import Kind
from app.models.user import User
from app.schemas.kind import McpServerConfig, Tool as ToolCRD

router = APIRouter()
logger = logging.getLogger(__name__)


# Request/Response Models
class UnifiedTool(BaseModel):
    """Unified tool representation for API responses"""

    name: str
    type: str  # 'public' or 'user' or 'group'
    displayName: Optional[str] = None
    toolType: str  # 'builtin' or 'mcp'
    description: str
    builtinName: Optional[str] = None
    mcpServer: Optional[McpServerConfig] = None
    parameters: Optional[dict] = None
    namespace: Optional[str] = None


class McpServerCreateRequest(BaseModel):
    """MCP Server configuration for creating a Tool"""

    type: str  # stdio | sse | streamable-http
    url: Optional[str] = None
    command: Optional[str] = None
    args: Optional[List[str]] = None
    env: Optional[dict] = None
    headers: Optional[dict] = None
    timeout: Optional[int] = 300


class ToolCreateRequest(BaseModel):
    """Request body for creating a Tool"""

    name: str
    displayName: Optional[str] = None
    type: str  # builtin | mcp
    description: str

    # For builtin type
    builtinName: Optional[str] = None

    # For mcp type
    mcpServer: Optional[McpServerCreateRequest] = None

    # Optional parameters schema
    parameters: Optional[dict] = None


class ToolUpdateRequest(BaseModel):
    """Request body for updating a Tool"""

    displayName: Optional[str] = None
    description: Optional[str] = None
    mcpServer: Optional[McpServerCreateRequest] = None
    parameters: Optional[dict] = None


class ToolListResponse(BaseModel):
    """Response for listing tools"""

    data: List[UnifiedTool]


def _tool_to_unified(tool: Kind) -> UnifiedTool:
    """Convert Kind (Tool) to UnifiedTool"""
    tool_crd = ToolCRD.model_validate(tool.json)

    # Determine resource type based on namespace and user_id
    if tool.user_id == 0:
        resource_type = "public"
    elif tool.namespace != "default":
        resource_type = "group"
    else:
        resource_type = "user"

    return UnifiedTool(
        name=tool.name,
        type=resource_type,
        displayName=tool_crd.metadata.displayName or tool.name,
        toolType=tool_crd.spec.type,
        description=tool_crd.spec.description,
        builtinName=tool_crd.spec.builtinName,
        mcpServer=tool_crd.spec.mcpServer,
        parameters=tool_crd.spec.parameters,
        namespace=tool.namespace,
    )


@router.get("", response_model=ToolListResponse)
def list_tools(
    scope: str = Query(
        "personal",
        description="Query scope: 'personal' (default), 'group', or 'all'",
    ),
    group_name: Optional[str] = Query(
        None, description="Group name (required when scope='group')"
    ),
    tool_type: Optional[str] = Query(
        None, description="Filter by tool type: 'builtin' or 'mcp'"
    ),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Get list of all available tools with scope support.

    Scope behavior:
    - scope='personal' (default): personal tools + public tools
    - scope='group': group tools + public tools (requires group_name)
    - scope='all': personal + public + all user's groups

    Each tool includes a 'type' field ('public', 'user', or 'group') to identify its source.
    """
    from app.services.group_permission import get_user_groups

    result = []

    # Determine which namespaces to query based on scope
    namespaces_to_query = []
    seen_names = set()

    if scope == "personal":
        namespaces_to_query = ["default"]
    elif scope == "group":
        if group_name:
            namespaces_to_query = [group_name]
        else:
            user_groups = get_user_groups(db, current_user.id)
            namespaces_to_query = user_groups if user_groups else []
    elif scope == "all":
        namespaces_to_query = ["default"] + get_user_groups(db, current_user.id)
    else:
        raise HTTPException(status_code=400, detail=f"Invalid scope: {scope}")

    # Get public tools (always included)
    public_query = db.query(Kind).filter(
        Kind.user_id == 0,
        Kind.kind == "Tool",
        Kind.namespace == "default",
        Kind.is_active == True,  # noqa: E712
    )

    public_tools = public_query.order_by(Kind.name.asc()).all()

    for tool in public_tools:
        try:
            unified = _tool_to_unified(tool)
            # Filter by tool type if specified
            if tool_type and unified.toolType != tool_type:
                continue
            result.append(unified)
            seen_names.add(tool.name)
        except Exception as e:
            logger.warning(f"Failed to parse public tool {tool.name}: {e}")

    # Get user-defined tools from specified namespaces
    for namespace in namespaces_to_query:
        if namespace == "default":
            # Query personal tools
            user_tools = (
                db.query(Kind)
                .filter(
                    Kind.user_id == current_user.id,
                    Kind.kind == "Tool",
                    Kind.namespace == "default",
                    Kind.is_active == True,  # noqa: E712
                )
                .order_by(Kind.name.asc())
                .all()
            )
        else:
            # Query group tools
            user_tools = (
                db.query(Kind)
                .filter(
                    Kind.kind == "Tool",
                    Kind.namespace == namespace,
                    Kind.is_active == True,  # noqa: E712
                )
                .order_by(Kind.name.asc())
                .all()
            )

        for tool in user_tools:
            try:
                # Deduplicate by name
                if tool.name in seen_names:
                    continue
                unified = _tool_to_unified(tool)
                # Filter by tool type if specified
                if tool_type and unified.toolType != tool_type:
                    continue
                result.append(unified)
                seen_names.add(tool.name)
            except Exception as e:
                logger.warning(f"Failed to parse user tool {tool.name}: {e}")

    return ToolListResponse(data=result)


@router.get("/unified", response_model=ToolListResponse)
def list_unified_tools(
    scope: str = Query(
        "all",
        description="Query scope: 'personal', 'group', or 'all' (default)",
    ),
    group_name: Optional[str] = Query(
        None, description="Group name (required when scope='group')"
    ),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Get unified list of all available tools (public + user + group).
    Alias for the main list endpoint with scope='all'.
    """
    return list_tools(
        scope=scope,
        group_name=group_name,
        tool_type=None,
        db=db,
        current_user=current_user,
    )


@router.get("/compatible")
def get_compatible_tools(
    shell_name: str = Query(..., description="Shell name to check compatibility"),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Get tools compatible with a specific Shell.

    Returns tools that:
    1. Are explicitly listed in Shell's supportedTools
    2. Are MCP type tools if Shell's supportedTools contains 'mcp'
    """
    from app.schemas.kind import Shell as ShellCRD

    # Find the shell (try user shells first, then public)
    shell = (
        db.query(Kind)
        .filter(
            Kind.user_id == current_user.id,
            Kind.kind == "Shell",
            Kind.name == shell_name,
            Kind.namespace == "default",
            Kind.is_active == True,  # noqa: E712
        )
        .first()
    )

    if not shell:
        # Try public shells
        shell = (
            db.query(Kind)
            .filter(
                Kind.user_id == 0,
                Kind.kind == "Shell",
                Kind.name == shell_name,
                Kind.namespace == "default",
                Kind.is_active == True,  # noqa: E712
            )
            .first()
        )

    if not shell:
        raise HTTPException(status_code=404, detail=f"Shell '{shell_name}' not found")

    shell_crd = ShellCRD.model_validate(shell.json)
    supported_tools = shell_crd.spec.supportedTools or []

    if not supported_tools:
        return {"data": []}

    # Check if 'mcp' wildcard is in supported tools
    supports_all_mcp = "mcp" in supported_tools
    explicit_tools = [t for t in supported_tools if t != "mcp"]

    # Get all available tools for this user
    all_tools_response = list_tools(
        scope="all",
        group_name=None,
        tool_type=None,
        db=db,
        current_user=current_user,
    )

    compatible_tools = []
    for tool in all_tools_response.data:
        # Include if explicitly listed
        if tool.name in explicit_tools:
            compatible_tools.append(tool)
        # Include MCP tools if shell supports 'mcp'
        elif supports_all_mcp and tool.toolType == "mcp":
            compatible_tools.append(tool)

    return {"data": [t.model_dump() for t in compatible_tools]}


@router.get("/{tool_name}", response_model=UnifiedTool)
def get_tool(
    tool_name: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Get a specific tool by name.

    Search order:
    1. User's personal tools
    2. User's group tools
    3. Public tools
    """
    from app.services.group_permission import get_user_groups

    # Try user's personal tools first
    tool = (
        db.query(Kind)
        .filter(
            Kind.user_id == current_user.id,
            Kind.kind == "Tool",
            Kind.name == tool_name,
            Kind.namespace == "default",
            Kind.is_active == True,  # noqa: E712
        )
        .first()
    )

    if tool:
        return _tool_to_unified(tool)

    # Try user's group tools
    user_groups = get_user_groups(db, current_user.id)
    for group_name in user_groups:
        tool = (
            db.query(Kind)
            .filter(
                Kind.kind == "Tool",
                Kind.name == tool_name,
                Kind.namespace == group_name,
                Kind.is_active == True,  # noqa: E712
            )
            .first()
        )
        if tool:
            return _tool_to_unified(tool)

    # Try public tools
    tool = (
        db.query(Kind)
        .filter(
            Kind.user_id == 0,
            Kind.kind == "Tool",
            Kind.name == tool_name,
            Kind.namespace == "default",
            Kind.is_active == True,  # noqa: E712
        )
        .first()
    )

    if tool:
        return _tool_to_unified(tool)

    raise HTTPException(status_code=404, detail=f"Tool '{tool_name}' not found")


@router.post("", response_model=UnifiedTool, status_code=status.HTTP_201_CREATED)
def create_tool(
    request: ToolCreateRequest,
    group_name: Optional[str] = Query(None, description="Group name (namespace)"),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Create a user-defined Tool.

    If group_name is provided, creates the tool in that group's namespace.
    User must have Developer+ permission in the group.
    """
    from app.schemas.namespace import GroupRole
    from app.services.group_permission import check_group_permission

    namespace = "default"

    if group_name:
        # Validate user has Developer+ permission in group
        if not check_group_permission(
            db, current_user.id, group_name, GroupRole.Developer
        ):
            raise HTTPException(
                status_code=403,
                detail=f"You need at least Developer role in group '{group_name}' to create tools",
            )
        namespace = group_name

    # Validate name format
    name_regex = r"^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$"
    if not re.match(name_regex, request.name):
        raise HTTPException(
            status_code=400,
            detail="Tool name must contain only lowercase letters, numbers, and hyphens",
        )

    # Check if name already exists in this namespace
    existing = (
        db.query(Kind)
        .filter(
            Kind.kind == "Tool",
            Kind.name == request.name,
            Kind.namespace == namespace,
            Kind.is_active == True,  # noqa: E712
        )
        .first()
    )
    if existing:
        raise HTTPException(
            status_code=400,
            detail=f"Tool '{request.name}' already exists in namespace '{namespace}'",
        )

    # Validate tool type and required fields
    if request.type not in ["builtin", "mcp"]:
        raise HTTPException(
            status_code=400,
            detail="Tool type must be 'builtin' or 'mcp'",
        )

    if request.type == "builtin" and not request.builtinName:
        raise HTTPException(
            status_code=400,
            detail="builtinName is required for builtin type tools",
        )

    if request.type == "mcp":
        if not request.mcpServer:
            raise HTTPException(
                status_code=400,
                detail="mcpServer configuration is required for mcp type tools",
            )
        if request.mcpServer.type not in ["stdio", "sse", "streamable-http"]:
            raise HTTPException(
                status_code=400,
                detail="MCP server type must be 'stdio', 'sse', or 'streamable-http'",
            )
        if request.mcpServer.type == "stdio" and not request.mcpServer.command:
            raise HTTPException(
                status_code=400,
                detail="command is required for stdio type MCP servers",
            )
        if request.mcpServer.type in ["sse", "streamable-http"] and not request.mcpServer.url:
            raise HTTPException(
                status_code=400,
                detail=f"url is required for {request.mcpServer.type} type MCP servers",
            )

    # Build Tool CRD
    tool_crd = {
        "apiVersion": "agent.wecode.io/v1",
        "kind": "Tool",
        "metadata": {
            "name": request.name,
            "namespace": namespace,
            "displayName": request.displayName,
            "labels": {"type": request.type},
        },
        "spec": {
            "type": request.type,
            "description": request.description,
            "builtinName": request.builtinName,
            "mcpServer": request.mcpServer.model_dump() if request.mcpServer else None,
            "parameters": request.parameters,
        },
        "status": {"state": "Available"},
    }

    db_obj = Kind(
        user_id=current_user.id,
        kind="Tool",
        name=request.name,
        namespace=namespace,
        json=tool_crd,
        is_active=True,
    )
    db.add(db_obj)
    db.commit()
    db.refresh(db_obj)

    return _tool_to_unified(db_obj)


@router.put("/{tool_name}", response_model=UnifiedTool)
def update_tool(
    tool_name: str,
    request: ToolUpdateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Update a user-defined Tool.

    Only user-defined tools can be updated. Public tools are read-only.
    For group tools, user must have Developer+ permission.
    """
    from app.schemas.namespace import GroupRole
    from app.services.group_permission import check_group_permission, get_user_groups

    # Try personal namespace first
    tool = (
        db.query(Kind)
        .filter(
            Kind.user_id == current_user.id,
            Kind.kind == "Tool",
            Kind.name == tool_name,
            Kind.namespace == "default",
            Kind.is_active == True,  # noqa: E712
        )
        .first()
    )

    if not tool:
        # Try group namespaces
        user_groups = get_user_groups(db, current_user.id)
        for group_name in user_groups:
            tool = (
                db.query(Kind)
                .filter(
                    Kind.kind == "Tool",
                    Kind.name == tool_name,
                    Kind.namespace == group_name,
                    Kind.is_active == True,  # noqa: E712
                )
                .first()
            )
            if tool:
                break

    if not tool:
        raise HTTPException(status_code=404, detail="User tool not found")

    # Check permissions
    if tool.namespace != "default":
        # Group tool - check permission
        if not check_group_permission(
            db, current_user.id, tool.namespace, GroupRole.Developer
        ):
            raise HTTPException(
                status_code=403,
                detail=f"You need at least Developer role in group '{tool.namespace}' to update this tool",
            )
    else:
        # Personal tool - check ownership
        if tool.user_id != current_user.id:
            raise HTTPException(status_code=403, detail="Access denied")

    # Parse existing CRD
    tool_crd = ToolCRD.model_validate(tool.json)

    # Update fields
    if request.displayName is not None:
        tool_crd.metadata.displayName = request.displayName

    if request.description is not None:
        tool_crd.spec.description = request.description

    if request.mcpServer is not None:
        # Validate MCP server config
        if tool_crd.spec.type != "mcp":
            raise HTTPException(
                status_code=400,
                detail="Cannot update mcpServer for non-MCP type tools",
            )
        if request.mcpServer.type not in ["stdio", "sse", "streamable-http"]:
            raise HTTPException(
                status_code=400,
                detail="MCP server type must be 'stdio', 'sse', or 'streamable-http'",
            )
        if request.mcpServer.type == "stdio" and not request.mcpServer.command:
            raise HTTPException(
                status_code=400,
                detail="command is required for stdio type MCP servers",
            )
        if request.mcpServer.type in ["sse", "streamable-http"] and not request.mcpServer.url:
            raise HTTPException(
                status_code=400,
                detail=f"url is required for {request.mcpServer.type} type MCP servers",
            )
        tool_crd.spec.mcpServer = McpServerConfig(**request.mcpServer.model_dump())

    if request.parameters is not None:
        tool_crd.spec.parameters = request.parameters

    # Save changes
    tool.json = tool_crd.model_dump(mode="json")
    db.add(tool)
    db.commit()
    db.refresh(tool)

    return _tool_to_unified(tool)


@router.delete("/{tool_name}")
def delete_tool(
    tool_name: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Delete a user-defined Tool.

    Only user-defined tools can be deleted. Public tools cannot be deleted.
    For group tools, user must have Developer+ permission.
    """
    from app.schemas.namespace import GroupRole
    from app.services.group_permission import check_group_permission, get_user_groups

    # Try personal namespace first
    tool = (
        db.query(Kind)
        .filter(
            Kind.user_id == current_user.id,
            Kind.kind == "Tool",
            Kind.name == tool_name,
            Kind.namespace == "default",
            Kind.is_active == True,  # noqa: E712
        )
        .first()
    )

    if not tool:
        # Try group namespaces
        user_groups = get_user_groups(db, current_user.id)
        for group_name in user_groups:
            tool = (
                db.query(Kind)
                .filter(
                    Kind.kind == "Tool",
                    Kind.name == tool_name,
                    Kind.namespace == group_name,
                    Kind.is_active == True,  # noqa: E712
                )
                .first()
            )
            if tool:
                break

    if not tool:
        raise HTTPException(status_code=404, detail="User tool not found")

    # Check permissions
    if tool.namespace != "default":
        # Group tool - check permission
        if not check_group_permission(
            db, current_user.id, tool.namespace, GroupRole.Developer
        ):
            raise HTTPException(
                status_code=403,
                detail=f"You need at least Developer role in group '{tool.namespace}' to delete this tool",
            )
    else:
        # Personal tool - check ownership
        if tool.user_id != current_user.id:
            raise HTTPException(status_code=403, detail="Access denied")

    # Hard delete
    db.delete(tool)
    db.commit()

    return {"message": "Tool deleted successfully"}
