# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import asyncio
import logging
from typing import List, Optional, Dict, Any
import requests
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.user import User
from app.schemas.github import Repository, Branch
from app.core.cache import cache_manager
from app.core.config import settings

logger = logging.getLogger(__name__)

async def get_github_repositories(
    user: User,
    page: int = 1,
    limit: int = 100
) -> List[Repository]:
    """Get user's GitHub repository list with pagination support and caching"""
    if not user.git_token:
        raise HTTPException(
            status_code=400,
            detail="Git token not configured"
        )

    # Check if this is the default request (page=1, limit=100)
    is_default_request = page == 1 and limit == 100
    
    # Try to get from cache first for default request
    if is_default_request:
        cache_key = cache_manager.generate_cache_key(user.id, user.git_domain, page, limit)
        cached_result = await cache_manager.get(cache_key)
        if cached_result:
            return [Repository(**repo) for repo in cached_result]
    
    # Check if we have full cached data
    full_cached = await _get_all_repositories_from_cache(user)
    if full_cached:
        # Slice the cached data for pagination
        start_idx = (page - 1) * limit
        end_idx = start_idx + limit
        paginated_repos = full_cached[start_idx:end_idx]
        
        return [
            Repository(
                id=repo["id"],
                name=repo["name"],
                full_name=repo["full_name"],
                clone_url=repo["clone_url"],
                private=repo["private"]
            ) for repo in paginated_repos
        ]

    try:
        headers = {
            "Authorization": f"token {user.git_token}",
            "Accept": "application/vnd.github.v3+json"
        }
        
        response = requests.get(
            "https://api.github.com/user/repos",
            headers=headers,
            params={
                "per_page": limit,
                "page": page,
                "sort": "updated"
            }
        )
        response.raise_for_status()
        
        repos = response.json()
        
        # If this is a default request and we got less than limit, cache it
        if is_default_request and len(repos) < limit:
            cache_key = cache_manager.generate_cache_key(user.id, user.git_domain, page, limit)
            await cache_manager.set(cache_key, repos, expire=settings.REPO_CACHE_EXPIRED_TIME)

            cache_key = cache_manager.generate_full_cache_key(user.id, user.git_domain)
            await cache_manager.set(cache_key, repos, expire=settings.REPO_CACHE_EXPIRED_TIME)
        
        # If this is a default request and we got exactly limit, start async full fetch
        if is_default_request and len(repos) == limit:
            # Start async background task to fetch all repositories
            asyncio.create_task(_fetch_all_repositories_async(user))
        
        return [
            Repository(
                id=repo["id"],
                name=repo["name"],
                full_name=repo["full_name"],
                clone_url=repo["clone_url"],
                private=repo["private"]
            ) for repo in repos
        ]
    except requests.exceptions.RequestException as e:
        raise HTTPException(
            status_code=502,
            detail=f"GitHub API error: {str(e)}"
        )

async def get_github_branches(
    user: User,
    repo_name: str
) -> List[Branch]:
    """Get branch list for specified repository (supports pagination for all branches)"""
    if not user.git_token:
        raise HTTPException(
            status_code=400,
            detail="Git token not configured"
        )

    try:
        headers = {
            "Authorization": f"token {user.git_token}",
            "Accept": "application/vnd.github.v3+json"
        }
        
        all_branches = []
        page = 1
        per_page = 100
        
        while True:
            response = requests.get(
                f"https://api.github.com/repos/{repo_name}/branches",
                headers=headers,
                params={
                    "per_page": per_page,
                    "page": page
                }
            )
            response.raise_for_status()
            
            branches = response.json()
            if not branches:
                break
                
            all_branches.extend(branches)
            page += 1
            
            # Prevent infinite loop, set maximum page limit
            if page > 50:  # Maximum 5000 branches
                break
        
        return [
            Branch(
                name=branch["name"],
                protected=branch.get("protected", False),
                default=branch.get("default", False)
            ) for branch in all_branches
        ]
    except requests.exceptions.RequestException as e:
        raise HTTPException(
            status_code=502,
            detail=f"GitHub API error: {str(e)}"
        )


async def search_repositories_by_name(
    user: User,
    query: str,
    timeout: int = 30
) -> List[Repository]:
    """Search repositories by name from cache or build if needed"""
    if not user.git_token:
        raise HTTPException(
            status_code=400,
            detail="Git token not configured"
        )
    
    # Normalize query for case-insensitive search
    query_lower = query.lower()
    
    # Try to get from full cache first
    full_cached = await _get_all_repositories_from_cache(user)
    
    if full_cached:
        # Search in cached repositories
        filtered_repos = [
            repo for repo in full_cached
            if query_lower in repo["name"].lower() or query_lower in repo["full_name"].lower()
        ]
        
        return [
            Repository(
                id=repo["id"],
                name=repo["name"],
                full_name=repo["full_name"],
                clone_url=repo["clone_url"],
                private=repo["private"]
            ) for repo in filtered_repos
        ]
    
    # Check if building is in progress
    is_building = await cache_manager.is_building(user.id, user.git_domain)
    
    if is_building:
        # Wait for building to complete with timeout
        start_time = asyncio.get_event_loop().time()
        while await cache_manager.is_building(user.id, user.git_domain):
            if asyncio.get_event_loop().time() - start_time > timeout:
                raise HTTPException(
                    status_code=408,
                    detail="Timeout waiting for repository data to be ready"
                )
            await asyncio.sleep(1)
        
        # Now try to get from cache again
        full_cached = await _get_all_repositories_from_cache(user, user.git_domain)
        if full_cached:
            filtered_repos = [
                repo for repo in full_cached
                if query_lower in repo["name"].lower() or query_lower in repo["full_name"].lower()
            ]
            
            return [
                Repository(
                    id=repo["id"],
                    name=repo["name"],
                    full_name=repo["full_name"],
                    clone_url=repo["clone_url"],
                    private=repo["private"]
                ) for repo in filtered_repos
            ]
    
    # No cache and not building, trigger full fetch
    await _fetch_all_repositories_async(user)
    
    # Get from cache after building
    full_cached = await _get_all_repositories_from_cache(user)
    if full_cached:
        filtered_repos = [
            repo for repo in full_cached
            if query_lower in repo["name"].lower() or query_lower in repo["full_name"].lower()
        ]
        
        return [
            Repository(
                id=repo["id"],
                name=repo["name"],
                full_name=repo["full_name"],
                clone_url=repo["clone_url"],
                private=repo["private"]
            ) for repo in filtered_repos
        ]
    
    # Fallback: fetch current page
    return await get_github_repositories(user, page=1, limit=100)


async def _fetch_all_repositories_async(
    user: User,
) -> None:
    """Asynchronously fetch all user repositories and cache them"""
    # Check if already building
    if await cache_manager.is_building(user.id, user.git_domain):
        return
    
    await cache_manager.set_building(user.id, user.git_domain, True)
    
    try:
        headers = {
            "Authorization": f"token {user.git_token}",
            "Accept": "application/vnd.github.v3+json"
        }
        
        all_repos = []
        page = 1
        per_page = 100
        
        logger.info(f"Fetching repositories for user {user.user_name}")
        
        while True:
            response = requests.get(
                "https://api.github.com/user/repos",
                headers=headers,
                params={
                    "per_page": per_page,
                    "page": page,
                    "sort": "updated"
                }
            )
            response.raise_for_status()
            
            repos = response.json()
            if not repos:
                break
                
            all_repos.extend(repos)
            
            # If we got less than per_page, we've reached the end
            if len(repos) < per_page:
                break
                
            page += 1
            
            # Prevent infinite loop, set maximum page limit
            if page > 50:  # Maximum 5000 repositories
                logger.warning(f"Reached maximum page limit (50) for user {user.id}")
                break
        
        # Cache the full repository list
        cache_key = cache_manager.generate_full_cache_key(user.id, user.git_domain)
        await cache_manager.set(cache_key, all_repos, expire=settings.REPO_CACHE_EXPIRED_TIME)
        
    except Exception:
        # Silently fail for background task
        logger.error(f"Failed to fetch repositories for user {user.user_name}, token {user.git_token}")
        pass
    finally:
        # Always clear building status
        await cache_manager.set_building(user.id, user.git_domain, False)
        logger.info(f"Repository fetch completed for user {user.user_name}")


async def _get_all_repositories_from_cache(
    user: User,
) -> Optional[List[Dict[str, Any]]]:
    """Get all repositories from cache"""
    cache_key = cache_manager.generate_full_cache_key(user.id, user.git_domain)
    return await cache_manager.get(cache_key)


async def validate_github_token(
    token: str
) -> Dict[str, Any]:
    """Validate GitHub token and return user information
    
    Args:
        token: GitHub personal access token
        
    Returns:
        Dict containing user information if token is valid
        
    Raises:
        HTTPException: If token is invalid or API request fails
    """
    if not token:
        raise HTTPException(
            status_code=400,
            detail="Git token is required"
        )

    try:
        headers = {
            "Authorization": f"token {token}",
            "Accept": "application/vnd.github.v3+json"
        }
        
        response = requests.get(
            "https://api.github.com/user",
            headers=headers
        )
        
        if response.status_code == 401:
            return {
                "valid": False,
            }
        
        response.raise_for_status()
        
        user_data = response.json()

        return {
            "valid": True,
            "user": {
                "id": user_data["id"],
                "login": user_data["login"],
                "name": user_data.get("name"),
                "avatar_url": user_data.get("avatar_url")
            }
        }
        
    except requests.exceptions.RequestException as e:
        if "401" in str(e):
            raise HTTPException(
                status_code=401,
                detail="Invalid GitHub token"
            )
        raise HTTPException(
            status_code=502,
            detail=f"GitHub API error: {str(e)}"
        )