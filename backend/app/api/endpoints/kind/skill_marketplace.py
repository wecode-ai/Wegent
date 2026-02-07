# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Skill Marketplace API endpoints for browsing, publishing, and collecting skills.
"""
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.models.user import User
from app.schemas.kind import (
    CollectSkillResponse,
    CollectionItem,
    MarketplaceSkill,
    MarketplaceSkillDetailResponse,
    MarketplaceSkillListResponse,
    MyCollectionsResponse,
    PublishToMarketplaceRequest,
    PublishToMarketplaceResponse,
    SkillCategoryCreateRequest,
    SkillCategoryListResponse,
    SkillCategoryResponse,
    SkillCategoryUpdateRequest,
    UpdateMarketplaceSkillRequest,
)
from app.services.adapters.skill_marketplace import (
    marketplace_skill_service,
    skill_category_service,
    skill_collection_service,
)

router = APIRouter()


# ==================== Skill Categories ====================


@router.get(
    "/skill-categories",
    response_model=SkillCategoryListResponse,
    summary="List all skill categories",
)
def list_skill_categories(
    db: Session = Depends(get_db),
    _: User = Depends(security.get_current_user),
) -> SkillCategoryListResponse:
    """
    List all skill categories with skill counts.

    Categories are sorted by sortOrder field.
    """
    return skill_category_service.list_categories(db)


@router.post(
    "/skill-categories",
    response_model=SkillCategoryResponse,
    summary="Create a skill category (admin only)",
)
def create_skill_category(
    request: SkillCategoryCreateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> SkillCategoryResponse:
    """
    Create a new skill category.

    Requires admin privileges.
    """
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin privileges required")

    return skill_category_service.create_category(
        db,
        name=request.name,
        display_name=request.displayName,
        display_name_en=request.displayNameEn,
        description=request.description,
        description_en=request.descriptionEn,
        icon=request.icon,
        sort_order=request.sortOrder,
    )


@router.put(
    "/skill-categories/{name}",
    response_model=SkillCategoryResponse,
    summary="Update a skill category (admin only)",
)
def update_skill_category(
    name: str,
    request: SkillCategoryUpdateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> SkillCategoryResponse:
    """
    Update an existing skill category.

    Requires admin privileges.
    """
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin privileges required")

    return skill_category_service.update_category(
        db,
        name=name,
        display_name=request.displayName,
        display_name_en=request.displayNameEn,
        description=request.description,
        description_en=request.descriptionEn,
        icon=request.icon,
        sort_order=request.sortOrder,
    )


@router.delete(
    "/skill-categories/{name}",
    status_code=204,
    summary="Delete a skill category (admin only)",
)
def delete_skill_category(
    name: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> None:
    """
    Delete a skill category.

    Cannot delete a category that has skills. Requires admin privileges.
    """
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin privileges required")

    skill_category_service.delete_category(db, name=name)


# ==================== Marketplace Browse ====================


@router.get(
    "/marketplace",
    response_model=MarketplaceSkillListResponse,
    summary="List marketplace skills",
)
def list_marketplace_skills(
    skip: int = Query(0, ge=0, description="Number of records to skip"),
    limit: int = Query(20, ge=1, le=100, description="Maximum records to return"),
    search: Optional[str] = Query(None, description="Search in name/description"),
    category: Optional[str] = Query(None, description="Filter by category"),
    tags: Optional[List[str]] = Query(None, description="Filter by tags (any match)"),
    bind_shells: Optional[List[str]] = Query(
        None, description="Filter by shell types (any match)"
    ),
    sort_by: str = Query(
        "downloadCount",
        description="Sort by field",
        pattern="^(downloadCount|createdAt|name)$",
    ),
    sort_order: str = Query(
        "desc", description="Sort direction", pattern="^(asc|desc)$"
    ),
    db: Session = Depends(get_db),
    _: User = Depends(security.get_current_user),
) -> MarketplaceSkillListResponse:
    """
    Browse marketplace skills with filtering and pagination.

    Supports searching, category filtering, tag filtering, and various sort options.
    """
    return marketplace_skill_service.list_marketplace_skills(
        db,
        skip=skip,
        limit=limit,
        search=search,
        category=category,
        tags=tags,
        bind_shells=bind_shells,
        sort_by=sort_by,
        sort_order=sort_order,
    )


@router.get(
    "/marketplace/{marketplace_skill_id}",
    response_model=MarketplaceSkillDetailResponse,
    summary="Get marketplace skill detail",
)
def get_marketplace_skill_detail(
    marketplace_skill_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> MarketplaceSkillDetailResponse:
    """
    Get detailed information about a marketplace skill.

    Includes publisher info, category info, and collection status.
    """
    return marketplace_skill_service.get_marketplace_skill_detail(
        db,
        marketplace_skill_id=marketplace_skill_id,
        current_user_id=current_user.id,
    )


# ==================== Publish Management ====================


@router.post(
    "/marketplace/publish",
    response_model=PublishToMarketplaceResponse,
    summary="Publish skill to marketplace",
)
def publish_to_marketplace(
    request: PublishToMarketplaceRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> PublishToMarketplaceResponse:
    """
    Publish a skill to the marketplace.

    The skill must belong to the current user and have bindShells configured.
    """
    marketplace_skill_id = marketplace_skill_service.publish_to_marketplace(
        db,
        request=request,
        user_id=current_user.id,
    )
    return PublishToMarketplaceResponse(marketplace_skill_id=marketplace_skill_id)


@router.put(
    "/marketplace/{marketplace_skill_id}",
    response_model=MarketplaceSkill,
    summary="Update marketplace skill",
)
def update_marketplace_skill(
    marketplace_skill_id: int,
    request: UpdateMarketplaceSkillRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> MarketplaceSkill:
    """
    Update a marketplace skill.

    Only the publisher can update their marketplace skill.
    """
    return marketplace_skill_service.update_marketplace_skill(
        db,
        marketplace_skill_id=marketplace_skill_id,
        user_id=current_user.id,
        category=request.category,
        market_description=request.market_description,
        readme=request.readme,
    )


@router.delete(
    "/marketplace/{marketplace_skill_id}",
    status_code=204,
    summary="Unpublish skill from marketplace",
)
def unpublish_from_marketplace(
    marketplace_skill_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> None:
    """
    Unpublish a skill from the marketplace (soft delete).

    Publisher or admin can unpublish.
    """
    marketplace_skill_service.unpublish_from_marketplace(
        db,
        marketplace_skill_id=marketplace_skill_id,
        user_id=current_user.id,
        is_admin=current_user.role == "admin",
    )


@router.get(
    "/marketplace/my-published",
    response_model=List[MarketplaceSkill],
    summary="Get my published skills",
)
def get_my_published_skills(
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> List[MarketplaceSkill]:
    """
    Get all skills published by the current user.
    """
    return marketplace_skill_service.get_my_published_skills(
        db, user_id=current_user.id
    )


# ==================== Collection Management ====================


@router.post(
    "/marketplace/{marketplace_skill_id}/collect",
    response_model=CollectSkillResponse,
    summary="Collect a marketplace skill",
)
def collect_skill(
    marketplace_skill_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> CollectSkillResponse:
    """
    Collect (favorite) a marketplace skill.

    Creates a lightweight reference in the user's skill list.
    """
    skill_id = skill_collection_service.collect_skill(
        db,
        marketplace_skill_id=marketplace_skill_id,
        user_id=current_user.id,
    )
    return CollectSkillResponse(skill_id=skill_id)


@router.delete(
    "/marketplace/{marketplace_skill_id}/collect",
    status_code=204,
    summary="Remove skill from collection",
)
def uncollect_skill(
    marketplace_skill_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> None:
    """
    Remove a skill from the user's collection.
    """
    skill_collection_service.uncollect_skill(
        db,
        marketplace_skill_id=marketplace_skill_id,
        user_id=current_user.id,
    )


@router.get(
    "/marketplace/my-collections",
    response_model=MyCollectionsResponse,
    summary="Get my collected skills",
)
def get_my_collections(
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> MyCollectionsResponse:
    """
    Get all skills collected by the current user.

    Includes availability status (whether the marketplace skill is still available).
    """
    items = skill_collection_service.get_my_collections(db, user_id=current_user.id)
    return MyCollectionsResponse(items=items)
