# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
API routes for Skill management (MCP tools, builtin tools, Claude Code skills)
"""
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Path, Query, status
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.security import get_current_user
from app.models.user import User
from app.services.skill_service import SkillService

router = APIRouter()


# ==================== Request/Response Schemas ====================


class SkillListResponse(BaseModel):
    """Response schema for skill list"""

    items: List[Dict[str, Any]]
    total: int
    page: int
    pageSize: int


class SkillResponse(BaseModel):
    """Response schema for single skill"""

    id: int
    name: str
    description: str
    version: Optional[str] = None
    author: Optional[str] = None
    tags: Optional[List[str]] = None
    skillType: str
    visibility: str
    category: Optional[str] = None
    mcpConfig: Optional[Dict[str, Any]] = None
    builtinConfig: Optional[Dict[str, Any]] = None
    createdAt: Optional[str] = None
    updatedAt: Optional[str] = None


class GhostSkillResponse(BaseModel):
    """Response schema for skill in ghost with status"""

    id: int
    name: str
    description: str
    version: Optional[str] = None
    author: Optional[str] = None
    tags: Optional[List[str]] = None
    skillType: str
    visibility: str
    category: Optional[str] = None
    mcpConfig: Optional[Dict[str, Any]] = None
    builtinConfig: Optional[Dict[str, Any]] = None
    status: str
    hasSecret: bool = False
    createdAt: Optional[str] = None
    updatedAt: Optional[str] = None


class AddSkillRequest(BaseModel):
    """Request schema for adding skill to ghost"""

    skillName: str


class UpdateSkillStatusRequest(BaseModel):
    """Request schema for updating skill status in ghost"""

    status: str  # available | pending_config | disabled


class SetSecretsRequest(BaseModel):
    """Request schema for setting skill secrets"""

    envValues: Dict[str, str]


class SecretsResponse(BaseModel):
    """Response schema for skill secrets"""

    envSchema: List[Dict[str, Any]]
    values: Dict[str, str]


class CategoryListResponse(BaseModel):
    """Response schema for category list"""

    categories: List[str]


class SuccessResponse(BaseModel):
    """Generic success response"""

    success: bool
    message: Optional[str] = None


# ==================== Market Endpoints ====================


@router.get("/market", response_model=SkillListResponse)
async def list_market_skills(
    skill_type: Optional[str] = Query(
        None, description="Filter by skill type (skill|mcp|builtin)"
    ),
    category: Optional[str] = Query(None, description="Filter by category"),
    visibility: str = Query("public", description="Filter by visibility"),
    search: Optional[str] = Query(None, description="Search term"),
    page: int = Query(1, ge=1, description="Page number"),
    page_size: int = Query(20, ge=1, le=100, alias="pageSize", description="Page size"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    List skills available in the market.

    Returns paginated list of skills with optional filtering.
    """
    skill_service = SkillService(db)
    skills, total = skill_service.list_market_skills(
        skill_type=skill_type,
        category=category,
        visibility=visibility,
        search=search,
        page=page,
        page_size=page_size,
    )

    return SkillListResponse(
        items=skills,
        total=total,
        page=page,
        pageSize=page_size,
    )


@router.get("/market/categories", response_model=CategoryListResponse)
async def list_skill_categories(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    List all unique skill categories.
    """
    skill_service = SkillService(db)
    categories = skill_service.get_categories()
    return CategoryListResponse(categories=categories)


@router.get("/market/{skill_name}", response_model=SkillResponse)
async def get_market_skill(
    skill_name: str = Path(..., description="Skill name"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Get a specific skill from the market by name.
    """
    skill_service = SkillService(db)
    skill = skill_service.get_skill_by_name(skill_name)

    if not skill:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Skill '{skill_name}' not found",
        )

    return SkillResponse(**skill)


# ==================== Ghost-Skill Association Endpoints ====================


@router.get("/ghosts/{ghost_id}/skills", response_model=List[GhostSkillResponse])
async def list_skills_in_ghost(
    ghost_id: int = Path(..., description="Ghost ID"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    List all skills associated with a Ghost.

    Returns skills with their status and configuration info.
    """
    skill_service = SkillService(db)
    skills = skill_service.list_skills_in_ghost(ghost_id)

    return [
        GhostSkillResponse(
            id=s["id"],
            name=s["name"],
            description=s["description"],
            version=s.get("version"),
            author=s.get("author"),
            tags=s.get("tags"),
            skillType=s["skillType"],
            visibility=s["visibility"],
            category=s.get("category"),
            mcpConfig=s.get("mcpConfig"),
            builtinConfig=s.get("builtinConfig"),
            status=s["status"],
            hasSecret=s.get("hassecret", False),
            createdAt=s.get("createdAt"),
            updatedAt=s.get("updatedAt"),
        )
        for s in skills
    ]


@router.post(
    "/ghosts/{ghost_id}/skills",
    response_model=SuccessResponse,
    status_code=status.HTTP_201_CREATED,
)
async def add_skill_to_ghost(
    request: AddSkillRequest,
    ghost_id: int = Path(..., description="Ghost ID"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Add a skill to a Ghost.

    The skill will be added with initial status based on its type:
    - MCP skills with required env vars: pending_config
    - MCP skills without required env vars: available
    - Builtin skills: available
    - Claude Code skills: pending_config (needs upload)
    """
    skill_service = SkillService(db)
    skill_service.add_skill_to_ghost(ghost_id, request.skillName)

    return SuccessResponse(
        success=True,
        message=f"Skill '{request.skillName}' added to Ghost",
    )


@router.delete(
    "/ghosts/{ghost_id}/skills/{skill_name}",
    response_model=SuccessResponse,
)
async def remove_skill_from_ghost(
    ghost_id: int = Path(..., description="Ghost ID"),
    skill_name: str = Path(..., description="Skill name"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Remove a skill from a Ghost.

    This will also delete any associated secrets.
    """
    skill_service = SkillService(db)
    skill_service.remove_skill_from_ghost(ghost_id, skill_name)

    return SuccessResponse(
        success=True,
        message=f"Skill '{skill_name}' removed from Ghost",
    )


@router.patch(
    "/ghosts/{ghost_id}/skills/{skill_name}/status",
    response_model=SuccessResponse,
)
async def update_skill_status(
    request: UpdateSkillStatusRequest,
    ghost_id: int = Path(..., description="Ghost ID"),
    skill_name: str = Path(..., description="Skill name"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Update a skill's status in a Ghost.

    Valid statuses: available, pending_config, disabled
    """
    skill_service = SkillService(db)
    skill_service.update_skill_status_in_ghost(ghost_id, skill_name, request.status)

    return SuccessResponse(
        success=True,
        message=f"Skill '{skill_name}' status updated to '{request.status}'",
    )


# ==================== Secrets Management Endpoints ====================


@router.get(
    "/ghosts/{ghost_id}/skills/{skill_name}/secrets",
    response_model=SecretsResponse,
)
async def get_skill_secrets(
    ghost_id: int = Path(..., description="Ghost ID"),
    skill_name: str = Path(..., description="Skill name"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Get secrets configuration for a skill in a Ghost.

    Returns the env schema and masked values (sensitive values are partially hidden).
    """
    skill_service = SkillService(db)
    secrets = skill_service.get_skill_secrets(ghost_id, skill_name, masked=True)

    return SecretsResponse(
        envSchema=secrets["envSchema"],
        values=secrets["values"],
    )


@router.put(
    "/ghosts/{ghost_id}/skills/{skill_name}/secrets",
    response_model=SuccessResponse,
)
async def set_skill_secrets(
    request: SetSecretsRequest,
    ghost_id: int = Path(..., description="Ghost ID"),
    skill_name: str = Path(..., description="Skill name"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Set secrets for a skill in a Ghost.

    The secrets are encrypted before storage.
    If all required env vars are set, the skill status is updated to 'available'.
    """
    skill_service = SkillService(db)
    skill_service.set_skill_secrets(ghost_id, skill_name, request.envValues)

    return SuccessResponse(
        success=True,
        message="Secrets saved successfully",
    )


@router.delete(
    "/ghosts/{ghost_id}/skills/{skill_name}/secrets",
    response_model=SuccessResponse,
)
async def delete_skill_secrets(
    ghost_id: int = Path(..., description="Ghost ID"),
    skill_name: str = Path(..., description="Skill name"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Delete secrets for a skill in a Ghost.

    The skill status will be updated to 'pending_config'.
    """
    skill_service = SkillService(db)
    result = skill_service.delete_skill_secrets(ghost_id, skill_name)

    return SuccessResponse(
        success=True,
        message="Secrets deleted successfully" if result["deleted"] else "No secrets to delete",
    )
