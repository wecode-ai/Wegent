# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from typing import Optional, List
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.dependencies import get_db
from app.core import security
from app.services.repository_service import repository_service
from app.models.user import User
from app.schemas.github import RepositoryResult, Branch

router = APIRouter()

@router.get("/repositories", response_model=List[RepositoryResult])
async def get_repositories(
    page: int = Query(1, ge=1, description="Page number"),
    limit: int = Query(100, ge=1, le=100, description="Number of repositories per page"),
    current_user: User = Depends(security.get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Get user's repository list from all configured providers"""
    repositories = await repository_service.get_repositories(current_user, page=page, limit=limit)
    return [
        RepositoryResult(
            git_repo_id=repo["id"],
            name=repo["name"],
            git_repo=repo["full_name"],
            git_url=repo["clone_url"],
            git_domain=repo.get("git_domain", "unknown"),
            private=repo["private"]
        ) for repo in repositories
    ]

@router.get("/repositories/branches", response_model=List[Branch])
async def get_branches(
    git_repo: Optional[str] = Query(None, description="owner/repository_name"),
    provider_type: Optional[str] = Query(None, description="Repository provider type (github/gitlab)"),
    current_user: User = Depends(security.get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Get branch list for specified repository"""
    if not git_repo:
        raise HTTPException(
            status_code=400,
            detail="Repository name is required"
        )
    return await repository_service.get_branches(current_user, git_repo, provider_type=provider_type)


@router.get("/repositories/search", response_model=List[RepositoryResult])
async def search_repositories(
    q: str = Query(..., description="Search query for repository name"),
    timeout: int = Query(30, ge=5, le=60, description="Search timeout in seconds"),
    current_user: User = Depends(security.get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Search repositories by name from all user's repositories"""

    repositories = await repository_service.search_repositories(current_user, q, timeout)
    return [
        RepositoryResult(
            git_repo_id=repo["id"],
            name=repo["name"],
            git_repo=repo["full_name"],
            git_url=repo["clone_url"],
            git_domain=repo.get("git_domain", "unknown"),
            private=repo["private"]
        ) for repo in repositories
    ]