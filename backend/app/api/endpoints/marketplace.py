# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Marketplace API endpoints for Agent Marketplace feature.

This module provides:
- Public endpoints for browsing and installing marketplace teams
- Admin endpoints for publishing and managing marketplace teams
"""

import logging
from typing import Optional

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.core.security import get_admin_user
from app.models.user import User
from app.schemas.marketplace import (
    CategoryListResponse,
    InstalledTeamListResponse,
    InstallTeamRequest,
    InstallTeamResponse,
    MarketplaceTeamDetail,
    MarketplaceTeamListResponse,
    PublishTeamRequest,
    UninstallTeamResponse,
    UpdateMarketplaceTeamRequest,
)
from app.services.marketplace_service import marketplace_service

logger = logging.getLogger(__name__)

router = APIRouter()


# ==================== Public Endpoints ====================


@router.get("/teams", response_model=MarketplaceTeamListResponse)
def list_marketplace_teams(
    page: int = Query(1, ge=1, description="Page number"),
    limit: int = Query(20, ge=1, le=100, description="Items per page"),
    search: Optional[str] = Query(None, description="Search keyword"),
    category: Optional[str] = Query(None, description="Category filter"),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Get marketplace teams list with pagination, search, and filtering.

    All logged-in users can browse the marketplace.
    """
    items, total = marketplace_service.get_marketplace_teams(
        db=db,
        user_id=current_user.id,
        page=page,
        limit=limit,
        search=search,
        category=category,
    )
    return MarketplaceTeamListResponse(total=total, items=items)


@router.get("/teams/{marketplace_id}", response_model=MarketplaceTeamDetail)
def get_marketplace_team_detail(
    marketplace_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Get detailed information for a marketplace team.

    All logged-in users can view team details.
    """
    return marketplace_service.get_marketplace_team_detail(
        db=db, marketplace_id=marketplace_id, user_id=current_user.id
    )


@router.get("/categories", response_model=CategoryListResponse)
def list_categories(
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Get all categories with their team counts.
    """
    categories = marketplace_service.get_categories(db=db)
    return CategoryListResponse(categories=categories)


# ==================== Installation Endpoints ====================


@router.post(
    "/teams/{marketplace_id}/install",
    response_model=InstallTeamResponse,
    status_code=status.HTTP_201_CREATED,
)
def install_team(
    marketplace_id: int,
    request: InstallTeamRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Install a marketplace team.

    Users can choose between reference mode (direct use, auto-sync) or
    copy mode (private copy, can modify).
    """
    return marketplace_service.install_team(
        db=db,
        marketplace_id=marketplace_id,
        user_id=current_user.id,
        request=request,
    )


@router.delete(
    "/teams/{marketplace_id}/uninstall", response_model=UninstallTeamResponse
)
def uninstall_team(
    marketplace_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Uninstall a marketplace team.

    For reference mode: removes from user's team list.
    For copy mode: marks as uninstalled but keeps the copied team (user can delete manually).
    """
    return marketplace_service.uninstall_team(
        db=db, marketplace_id=marketplace_id, user_id=current_user.id
    )


@router.get("/installed", response_model=InstalledTeamListResponse)
def list_installed_teams(
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Get user's installed marketplace teams.
    """
    items = marketplace_service.get_user_installed_teams(db=db, user_id=current_user.id)
    return InstalledTeamListResponse(total=len(items), items=items)


# ==================== Admin Endpoints ====================


@router.post("/admin/teams", status_code=status.HTTP_201_CREATED)
def publish_team_to_marketplace(
    request: PublishTeamRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Publish a team to the marketplace (admin only).

    The team must have user_id=0 (system team).
    """
    mp_team = marketplace_service.publish_team(db=db, request=request)
    return {"success": True, "marketplace_id": mp_team.id, "team_id": mp_team.team_id}


@router.put("/admin/teams/{marketplace_id}")
def update_marketplace_team(
    marketplace_id: int,
    request: UpdateMarketplaceTeamRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Update marketplace team information (admin only).
    """
    mp_team = marketplace_service.update_marketplace_team(
        db=db, marketplace_id=marketplace_id, request=request
    )
    return {"success": True, "marketplace_id": mp_team.id}


@router.delete("/admin/teams/{marketplace_id}")
def unpublish_marketplace_team(
    marketplace_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Unpublish/deactivate a marketplace team (admin only).

    This soft-deletes the marketplace entry. Existing installations
    will still work but the team won't appear in marketplace listings.
    """
    marketplace_service.unpublish_team(db=db, marketplace_id=marketplace_id)
    return {"success": True, "message": "Team unpublished from marketplace"}


@router.get("/admin/teams")
def list_admin_marketplace_teams(
    page: int = Query(1, ge=1, description="Page number"),
    limit: int = Query(20, ge=1, le=100, description="Items per page"),
    include_inactive: bool = Query(True, description="Include inactive teams"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Get all marketplace teams for admin management (admin only).

    Includes inactive teams by default.
    """
    items, total = marketplace_service.get_admin_marketplace_teams(
        db=db, page=page, limit=limit, include_inactive=include_inactive
    )
    return {"total": total, "items": items}
