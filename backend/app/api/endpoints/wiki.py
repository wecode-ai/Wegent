# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.core.wiki_config import wiki_settings
from app.db.session import get_wiki_db
from app.models.user import User
from app.schemas.wiki import (
    WikiContentInDB,
    WikiContentWriteRequest,
    WikiGenerationCreate,
    WikiGenerationDetail,
    WikiGenerationInDB,
    WikiGenerationListResponse,
    WikiProjectDetail,
    WikiProjectInDB,
    WikiProjectListResponse,
)
from app.services.user import user_service
from app.services.wiki_service import wiki_service

router = APIRouter()
internal_router = APIRouter()


def _verify_internal_token(authorization: str = Header(default="")) -> None:
    """Simple fixed-token verification for internal content writer."""
    if not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing or invalid Authorization header",
        )
    token = authorization[7:].strip()
    if token != wiki_settings.INTERNAL_API_TOKEN:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Invalid internal API token",
        )


def _resolve_user_id(
    account_id: Optional[int], current_user: User, main_db: Session
) -> int:
    """Resolve effective user ID, allowing admin override when account_id is provided."""
    if account_id is None or account_id == current_user.id:
        return current_user.id

    if current_user.user_name != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only admin users can override account_id",
        )

    override_user = user_service.get_user_by_id(main_db, account_id)
    if not override_user.is_active:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"User with id {account_id} is inactive",
        )
    return override_user.id


# ========== Generation Endpoints ==========
@router.post(
    "/generations",
    response_model=WikiGenerationInDB,
    status_code=status.HTTP_201_CREATED,
)
def create_wiki_generation(
    generation_create: WikiGenerationCreate,
    account_id: Optional[int] = Query(
        default=None,
        ge=1,
        description="Override account ID to execute with a different user context",
    ),
    current_user: User = Depends(security.get_current_user),
    wiki_db: Session = Depends(get_wiki_db),
    main_db: Session = Depends(get_db),
):
    """Create wiki document generation task"""
    user_id = _resolve_user_id(account_id, current_user, main_db)
    return wiki_service.create_wiki_generation(
        wiki_db=wiki_db, obj_in=generation_create, user_id=user_id
    )


@router.get("/generations", response_model=WikiGenerationListResponse)
def get_wiki_generations(
    page: int = Query(1, ge=1, description="Page number"),
    limit: int = Query(10, ge=1, le=100, description="Items per page"),
    project_id: int = Query(None, description="Filter by project ID"),
    account_id: Optional[int] = Query(
        default=None,
        ge=1,
        description="Override account ID to execute with a different user context. If not provided, returns all users' generations",
    ),
    current_user: User = Depends(security.get_current_user),
    wiki_db: Session = Depends(get_wiki_db),
    main_db: Session = Depends(get_db),
):
    """Get wiki generation task list. If account_id is not provided, returns all users' generations"""
    skip = (page - 1) * limit

    # When account_id is not provided, pass user_id=0 to query all users' generations
    # When account_id is provided, use _resolve_user_id to resolve the user ID
    if account_id is None:
        user_id = 0  # 0 means query all users
    else:
        user_id = _resolve_user_id(account_id, current_user, main_db)

    items, total = wiki_service.get_generations(
        db=wiki_db, user_id=user_id, project_id=project_id, skip=skip, limit=limit
    )
    return {"total": total, "items": items}


@router.get("/generations/{generation_id}", response_model=WikiGenerationDetail)
def get_wiki_generation(
    generation_id: int,
    account_id: Optional[int] = Query(
        default=None,
        ge=1,
        description="Override account ID to execute with a different user context. If not provided, returns generation for all users",
    ),
    current_user: User = Depends(security.get_current_user),
    wiki_db: Session = Depends(get_wiki_db),
    main_db: Session = Depends(get_db),
):
    """Get wiki generation task detail. If account_id is not provided, returns generation for all users"""
    # When account_id is not provided, pass user_id=0 to query all users' generation details
    # When account_id is provided, use _resolve_user_id to resolve the user ID
    if account_id is None:
        user_id = 0  # 0 means query all users
    else:
        user_id = _resolve_user_id(account_id, current_user, main_db)

    generation = wiki_service.get_generation_detail(
        db=wiki_db, generation_id=generation_id, user_id=user_id
    )

    # Get project info
    project = wiki_service.get_project_detail(
        db=wiki_db, project_id=generation.project_id
    )

    # Get contents
    contents = wiki_service.get_generation_contents(
        db=wiki_db, generation_id=generation_id, user_id=user_id
    )

    # Build response
    generation_dict = generation.__dict__.copy()
    generation_dict["project"] = project
    generation_dict["contents"] = contents

    return generation_dict


@internal_router.post("/generations/contents", status_code=status.HTTP_204_NO_CONTENT)
def save_wiki_generation_contents(
    payload: WikiContentWriteRequest,
    _: None = Depends(_verify_internal_token),
    wiki_db: Session = Depends(get_wiki_db),
):
    """Write wiki generation contents and update status (internal use)."""
    wiki_service.save_generation_contents(
        wiki_db=wiki_db,
        payload=payload,
    )
    return None


@router.get(
    "/generations/{generation_id}/contents", response_model=list[WikiContentInDB]
)
def get_wiki_generation_contents(
    generation_id: int,
    account_id: Optional[int] = Query(
        default=None,
        ge=1,
        description="Override account ID to execute with a different user context. If not provided, returns contents for all users",
    ),
    current_user: User = Depends(security.get_current_user),
    wiki_db: Session = Depends(get_wiki_db),
    main_db: Session = Depends(get_db),
):
    """Get wiki generation contents. If account_id is not provided, returns contents for all users"""
    # When account_id is not provided, pass user_id=0 to query all users' generation contents
    # When account_id is provided, use _resolve_user_id to resolve the user ID
    if account_id is None:
        user_id = 0  # 0 means query all users
    else:
        user_id = _resolve_user_id(account_id, current_user, main_db)

    return wiki_service.get_generation_contents(
        db=wiki_db, generation_id=generation_id, user_id=user_id
    )


@router.post("/generations/{generation_id}/cancel", response_model=WikiGenerationInDB)
def cancel_wiki_generation(
    generation_id: int,
    account_id: Optional[int] = Query(
        default=None,
        ge=1,
        description="Override account ID to execute with a different user context",
    ),
    current_user: User = Depends(security.get_current_user),
    wiki_db: Session = Depends(get_wiki_db),
    main_db: Session = Depends(get_db),
):
    """Cancel a wiki generation task"""
    user_id = _resolve_user_id(account_id, current_user, main_db)
    return wiki_service.cancel_wiki_generation(
        wiki_db=wiki_db, generation_id=generation_id, user_id=user_id
    )


# ========== Project Endpoints ==========
@router.get("/projects", response_model=WikiProjectListResponse)
def get_wiki_projects(
    page: int = Query(1, ge=1, description="Page number"),
    limit: int = Query(10, ge=1, le=100, description="Items per page"),
    project_type: str = Query(None, description="Filter by project type"),
    source_type: str = Query(None, description="Filter by source type"),
    db: Session = Depends(get_wiki_db),
):
    """Get wiki project list"""
    skip = (page - 1) * limit
    items, total = wiki_service.get_projects(
        db=db,
        skip=skip,
        limit=limit,
        project_type=project_type,
        source_type=source_type,
    )
    return {"total": total, "items": items}


@router.get("/projects/{project_id}", response_model=WikiProjectDetail)
def get_wiki_project(project_id: int, db: Session = Depends(get_wiki_db)):
    """Get wiki project detail"""
    project = wiki_service.get_project_detail(db=db, project_id=project_id)

    # Get recent generations for this project
    generations, _ = wiki_service.get_generations(
        db=db,
        user_id=0,  # Get all users' generations for this project
        project_id=project_id,
        skip=0,
        limit=10,
    )

    # Build response
    project_dict = project.__dict__.copy()
    project_dict["generations"] = generations

    return project_dict


# ========== Statistics Endpoints ==========
@router.get("/stats/summary")
def get_wiki_stats_summary(
    account_id: Optional[int] = Query(
        default=None,
        ge=1,
        description="Override account ID to execute with a different user context",
    ),
    current_user: User = Depends(security.get_current_user),
    wiki_db: Session = Depends(get_wiki_db),
    main_db: Session = Depends(get_db),
):
    """Get wiki statistics summary for current user"""
    # Get user's generations count by status
    from app.models.wiki import WikiGeneration

    user_id = _resolve_user_id(account_id, current_user, main_db)

    total_generations = (
        wiki_db.query(WikiGeneration).filter(WikiGeneration.user_id == user_id).count()
    )

    pending_generations = (
        wiki_db.query(WikiGeneration)
        .filter(WikiGeneration.user_id == user_id, WikiGeneration.status == "PENDING")
        .count()
    )

    running_generations = (
        wiki_db.query(WikiGeneration)
        .filter(WikiGeneration.user_id == user_id, WikiGeneration.status == "RUNNING")
        .count()
    )

    completed_generations = (
        wiki_db.query(WikiGeneration)
        .filter(WikiGeneration.user_id == user_id, WikiGeneration.status == "COMPLETED")
        .count()
    )

    failed_generations = (
        wiki_db.query(WikiGeneration)
        .filter(WikiGeneration.user_id == user_id, WikiGeneration.status == "FAILED")
        .count()
    )

    cancelled_generations = (
        wiki_db.query(WikiGeneration)
        .filter(WikiGeneration.user_id == user_id, WikiGeneration.status == "CANCELLED")
        .count()
    )

    return {
        "total_generations": total_generations,
        "pending_generations": pending_generations,
        "running_generations": running_generations,
        "completed_generations": completed_generations,
        "failed_generations": failed_generations,
        "cancelled_generations": cancelled_generations,
    }
