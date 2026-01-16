# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import logging
from typing import Any, Dict, List

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.dependencies import get_db
from app.core import security
from app.models.user import User
from app.schemas.github import Branch, RepositoryResult
from app.services.repository import repository_service

# Logger instance
logger = logging.getLogger(__name__)

router = APIRouter()


@router.post("/repositories/refresh")
async def refresh_repositories(
    current_user: User = Depends(security.get_current_user),
):
    """
    Force refresh user's repository cache.
    Clears the Redis cache for all git domains configured by the user,
    forcing fresh data to be fetched from Git providers on next request.
    """
    cleared_domains = await repository_service.clear_user_cache(current_user)
    logger.info(
        f"User {current_user.user_name} cleared repository cache for domains: {cleared_domains}"
    )
    return {
        "success": True,
        "message": "Repository cache cleared successfully",
        "cleared_domains": cleared_domains,
    }


@router.get("/repositories", response_model=List[RepositoryResult])
async def get_repositories(
    page: int = Query(1, ge=1, description="Page number"),
    limit: int = Query(
        1000, ge=1, le=5000, description="Number of repositories per page (max 5000)"
    ),
    current_user: User = Depends(security.get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Get user's repository list from all configured providers"""
    repositories = await repository_service.get_repositories(
        current_user, page=page, limit=limit
    )
    return [
        RepositoryResult(
            git_repo_id=repo["id"],
            name=repo["name"],
            git_repo=repo["full_name"],
            git_url=repo["clone_url"],
            git_domain=repo.get("git_domain", "unknown"),
            type=repo["type"],
            private=repo["private"],
        )
        for repo in repositories
    ]


@router.get("/repositories/branches", response_model=List[Branch])
async def get_branches(
    git_repo: str = Query(..., description="owner/repository_name"),
    type: str = Query(
        ..., description="Repository provider type (github/gitlab/gitee/gitea)"
    ),
    git_domain: str = Query(
        ...,
        description="Repository git domain, required (e.g., github.com, gitlab.com, gitea.example.com)",
    ),
    current_user: User = Depends(security.get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Get branch list for specified repository"""
    return await repository_service.get_branches(
        current_user, git_repo, type=type, git_domain=git_domain
    )


@router.get("/repositories/diff")
async def get_branch_diff(
    git_repo: str = Query(..., description="owner/repository_name"),
    source_branch: str = Query(..., description="Source branch name"),
    target_branch: str = Query(..., description="Target branch name"),
    type: str = Query(
        ..., description="Repository provider type (github/gitlab/gitee/gitea)"
    ),
    git_domain: str = Query(
        ...,
        description="Repository git domain, required (e.g., github.com, gitlab.com, gitea.example.com)",
    ),
    current_user: User = Depends(security.get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Get diff between two branches for specified repository"""
    return await repository_service.get_branch_diff(
        current_user, git_repo, source_branch, target_branch, type, git_domain
    )


@router.get("/repositories/search", response_model=List[RepositoryResult])
async def search_repositories(
    q: str = Query(..., description="Search query for repository name"),
    timeout: int = Query(30, ge=5, le=60, description="Search timeout in seconds"),
    fullmatch: bool = Query(
        False, description="Enable exact match (true) or partial match (false)"
    ),
    current_user: User = Depends(security.get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Search repositories by name from all user's repositories"""

    repositories = await repository_service.search_repositories(
        current_user, q, timeout, fullmatch
    )
    return [
        RepositoryResult(
            git_repo_id=repo["id"],
            name=repo["name"],
            git_repo=repo["full_name"],
            git_url=repo["clone_url"],
            git_domain=repo.get("git_domain", "unknown"),
            type=repo["type"],
            private=repo["private"],
        )
        for repo in repositories
    ]
