# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Tool API endpoints for managing tools and tool market
"""
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.core.exceptions import ConflictException, NotFoundException
from app.models.user import User
from app.schemas.tool import (
    GhostToolDetail,
    GhostToolSecretResponse,
    GhostToolSecretUpdate,
    ToolCategoryResponse,
    ToolCreate,
    ToolInDB,
    ToolListResponse,
    ToolMarketItem,
    ToolMarketListResponse,
    ToolStatus,
    ToolUpdate,
)
from app.services.tool_service import tool_service

router = APIRouter()


# ============================================================================
# Tool Market API
# ============================================================================


@router.get("/market", response_model=ToolMarketListResponse)
def list_market_tools(
    category: Optional[str] = Query(None, description="Filter by category"),
    search: Optional[str] = Query(None, description="Search in name and description"),
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=100),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    List public tools available in the market.
    """
    tools, total, categories = tool_service.list_market_tools(
        db, category=category, search=search, skip=skip, limit=limit
    )

    items = [
        ToolMarketItem(
            id=t.id,
            name=t.name,
            type=t.type,
            category=t.category,
            tags=t.tags,
            description=t.description,
            mcp_config=t.mcp_config,
            builtin_config=t.builtin_config,
        )
        for t in tools
    ]

    return ToolMarketListResponse(total=total, items=items, categories=categories)


@router.get("/market/{tool_id}", response_model=ToolMarketItem)
def get_market_tool(
    tool_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Get a specific tool from the market.
    """
    tool = tool_service.get_tool(db, tool_id)
    if not tool:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Tool with ID {tool_id} not found",
        )

    return ToolMarketItem(
        id=tool.id,
        name=tool.name,
        type=tool.type,
        category=tool.category,
        tags=tool.tags,
        description=tool.description,
        mcp_config=tool.mcp_config,
        builtin_config=tool.builtin_config,
    )


@router.get("/categories", response_model=ToolCategoryResponse)
def get_tool_categories(
    current_user: User = Depends(security.get_current_user),
):
    """
    Get all available tool categories.
    """
    categories = tool_service.get_categories()
    return ToolCategoryResponse(categories=categories)


# ============================================================================
# Tool CRUD API
# ============================================================================


@router.get("", response_model=ToolListResponse)
def list_tools(
    visibility: Optional[str] = Query(None, description="Filter by visibility"),
    category: Optional[str] = Query(None, description="Filter by category"),
    tool_type: Optional[str] = Query(None, description="Filter by type"),
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=100),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    List tools for the current user (personal + public).
    """
    tools, total = tool_service.list_tools(
        db,
        user_id=current_user.id,
        visibility=visibility,
        category=category,
        tool_type=tool_type,
        skip=skip,
        limit=limit,
    )

    items = [ToolInDB.model_validate(t) for t in tools]
    return ToolListResponse(total=total, items=items)


@router.post("", response_model=ToolInDB, status_code=status.HTTP_201_CREATED)
def create_tool(
    tool_create: ToolCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Create a new tool.
    """
    try:
        tool = tool_service.create_tool(db, current_user.id, tool_create)
        return ToolInDB.model_validate(tool)
    except ConflictException as e:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))


@router.get("/{tool_id}", response_model=ToolInDB)
def get_tool(
    tool_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Get a specific tool.
    """
    tool = tool_service.get_tool(db, tool_id)
    if not tool:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Tool with ID {tool_id} not found",
        )

    return ToolInDB.model_validate(tool)


@router.put("/{tool_id}", response_model=ToolInDB)
def update_tool(
    tool_id: int,
    tool_update: ToolUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Update a tool.
    """
    try:
        tool = tool_service.update_tool(db, current_user.id, tool_id, tool_update)
        return ToolInDB.model_validate(tool)
    except NotFoundException as e:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(e))


@router.delete("/{tool_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_tool(
    tool_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Delete a tool.
    """
    try:
        tool_service.delete_tool(db, current_user.id, tool_id)
    except NotFoundException as e:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(e))


# ============================================================================
# Ghost Tool API
# ============================================================================


@router.get("/ghosts/{ghost_id}/tools", response_model=List[GhostToolDetail])
def list_ghost_tools(
    ghost_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    List all tools in a Ghost.
    """
    try:
        return tool_service.list_tools_in_ghost(db, current_user.id, ghost_id)
    except NotFoundException as e:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(e))


@router.post("/ghosts/{ghost_id}/tools")
def add_tool_to_ghost(
    ghost_id: int,
    tool_name: str = Query(..., description="Tool name to add"),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Add a tool to a Ghost.
    """
    try:
        return tool_service.add_tool_to_ghost(db, current_user.id, ghost_id, tool_name)
    except NotFoundException as e:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(e))
    except ConflictException as e:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(e))


@router.delete("/ghosts/{ghost_id}/tools/{tool_name}")
def remove_tool_from_ghost(
    ghost_id: int,
    tool_name: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Remove a tool from a Ghost.
    """
    try:
        tool_service.remove_tool_from_ghost(db, current_user.id, ghost_id, tool_name)
        return {"message": f"Tool '{tool_name}' removed from Ghost"}
    except NotFoundException as e:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(e))


@router.put("/ghosts/{ghost_id}/tools/{tool_name}")
def update_tool_status(
    ghost_id: int,
    tool_name: str,
    status: ToolStatus = Query(..., description="New status"),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Update tool status in a Ghost (enable/disable).
    """
    try:
        return tool_service.update_tool_status_in_ghost(
            db, current_user.id, ghost_id, tool_name, status
        )
    except NotFoundException as e:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(e))


# ============================================================================
# Tool Secret API
# ============================================================================


@router.get(
    "/ghosts/{ghost_id}/tools/{tool_name}/secrets",
    response_model=GhostToolSecretResponse,
)
def get_tool_secrets(
    ghost_id: int,
    tool_name: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Get secret configuration for a tool in a Ghost (values are masked).
    """
    try:
        env = tool_service.get_tool_secrets(
            db, current_user.id, ghost_id, tool_name, masked=True
        )
        return GhostToolSecretResponse(env=env)
    except NotFoundException as e:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(e))


@router.put("/ghosts/{ghost_id}/tools/{tool_name}/secrets")
def set_tool_secrets(
    ghost_id: int,
    tool_name: str,
    secret_update: GhostToolSecretUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Set secret configuration for a tool in a Ghost.
    """
    try:
        tool_service.set_tool_secrets(
            db, current_user.id, ghost_id, tool_name, secret_update.env
        )
        return {"message": "Secrets configured successfully"}
    except NotFoundException as e:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(e))
