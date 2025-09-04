# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from typing import Optional, List
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.dependencies import get_db
from app.core import security
from app.core.factory import repository_provider
from app.models.user import User
from app.schemas.github import RepositoryResult, Branch, TokenValidationResponse

router = APIRouter()

@router.get("/repositories", response_model=List[RepositoryResult])
async def get_repositories(
    page: int = Query(1, ge=1, description="Page number"),
    limit: int = Query(100, ge=1, le=100, description="Number of repositories per page"),
    current_user: User = Depends(security.get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Get user's repository list"""
    repositories = await repository_provider.get_repositories(current_user, page=page, limit=limit)
    return [
        RepositoryResult(
            git_repo_id=repo["id"],
            name=repo["name"],
            git_repo=repo["full_name"],
            git_url=repo["clone_url"],
            git_domain="github.com",
            private=repo["private"]
        ) for repo in repositories
    ]

@router.get("/repositories/branches", response_model=List[Branch])
async def get_branches(
    git_repo: Optional[str] = Query(None, description="owner/repository_name"),
    current_user: User = Depends(security.get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Get branch list for specified repository"""
    if not git_repo:
        raise HTTPException(
            status_code=400,
            detail="Repository name is required"
        )
    return await repository_provider.get_branches(current_user, git_repo)


@router.get("/validate-token", response_model=TokenValidationResponse)
def validate_token(
    token: str = Query(..., description="Repository access token to validate"),
    current_user: User = Depends(security.get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Validate repository token and return user information"""
    return repository_provider.validate_token(token)


@router.get("/repositories/search", response_model=List[RepositoryResult])
async def search_repositories(
    q: str = Query(..., description="Search query for repository name"),
    timeout: int = Query(30, ge=5, le=60, description="Search timeout in seconds"),
    current_user: User = Depends(security.get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Search repositories by name from user's repositories"""

    repositories = await repository_provider.search_repositories(current_user, q, timeout)
    return [
        RepositoryResult(
            git_repo_id=repo["id"],
            name=repo["name"],
            git_repo=repo["full_name"],
            git_url=repo["clone_url"],
            git_domain="github.com",
            private=repo["private"]
        ) for repo in repositories
    ]