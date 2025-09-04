# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from typing import Optional, List
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.dependencies import get_db
from app.core import security
from app.models.user import User
from app.schemas.github import Repository, Branch, TokenValidationResponse
from app.services.github import (
    get_github_repositories,
    get_github_branches,
    validate_github_token,
    search_repositories_by_name
)

router = APIRouter()

@router.get("/repositories", response_model=List[Repository])
async def get_repositories(
    page: int = Query(1, ge=1, description="Page number"),
    limit: int = Query(100, ge=1, le=100, description="Number of repositories per page"),
    current_user: User = Depends(security.get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Get user's GitHub repository list"""
    return await get_github_repositories(current_user, page=page, limit=limit)

@router.get("/repositories/branches", response_model=List[Branch])
async def get_branches(
    repo_name: Optional[str] = Query(None, description="owner/repository_name"),
    current_user: User = Depends(security.get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Get branch list for specified repository"""
    if not repo_name:
        raise HTTPException(
            status_code=400,
            detail="Repository name is required"
        )
    return await get_github_branches(current_user, repo_name)


@router.get("/validate-token", response_model=TokenValidationResponse, include_in_schema=False)
async def validate_token(
    token: str = Query(..., description="GitHub personal access token to validate"),
    current_user: User = Depends(security.get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Validate GitHub token and return user information"""
    return await validate_github_token(token)


@router.get("/repositories/search", response_model=List[Repository])
async def search_repositories(
    q: str = Query(..., description="Search query for repository name"),
    timeout: int = Query(30, ge=5, le=60, description="Search timeout in seconds"),
    current_user: User = Depends(security.get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Search repositories by name from user's GitHub repositories"""
    if not current_user.git_token:
        raise HTTPException(
            status_code=400,
            detail="Git token not configured"
        )
    
    return await search_repositories_by_name(current_user, q, timeout)
