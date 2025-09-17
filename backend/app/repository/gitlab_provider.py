# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
GitLab repository provider implementation
"""
import asyncio
import logging
from typing import List, Dict, Any, Optional
import requests
from fastapi import HTTPException

from app.repository.interfaces.repository_provider import RepositoryProvider
from app.models.user import User
from app.schemas.github import Repository, Branch
from app.core.cache import cache_manager
from app.core.config import settings


class GitLabProvider(RepositoryProvider):
    """
    GitLab repository provider implementation
    """
    
    def __init__(self):
        self.logger = logging.getLogger(__name__)
        self.api_base_url = "https://gitlab.com/api/v4"
        self.domain = "gitlab.com"
        self.type = "gitlab"
    
    def _get_git_info(self, user: User) -> Dict[str, Any]:
        """
        Get GitLab related information from user's git_info
        
        Args:
            user: User object
            
        Returns:
            Dictionary containing git_domain, git_token
            
        Raises:
            HTTPException: Raised when GitLab information is not configured
        """
        if not user.git_info:
            raise HTTPException(
                status_code=400,
                detail="Git information not configured"
            )
        
        for info in user.git_info:
            if info.get("type") == self.type:
                return {
                    "git_domain": info.get("git_domain", ""),
                    "git_token": info.get("git_token", ""),
                    "type": info.get("type", "")
                }
        
        raise HTTPException(
            status_code=400,
            detail=f"Git information for {self.domain} not configured"
        )
    
    def _get_api_base_url(self, git_domain: str = None) -> str:
        """Get API base URL based on git domain"""
        if not git_domain or git_domain == self.domain:
            return self.api_base_url
        
        if git_domain == "gitlab.com":
            return "https://gitlab.com/api/v4"
        else:
            # Custom GitLab domain
            return f"https://{git_domain}/api/v4"

    async def get_repositories(
        self,
        user: User,
        page: int = 1,
        limit: int = 100
    ) -> List[Dict[str, Any]]:
        """
        Get user's GitLab repository list
        
        Args:
            user: User object
            page: Page number
            limit: Items per page
            
        Returns:
            Repository list
            
        Raises:
            HTTPException: Raised when retrieval fails
        """
        git_info = self._get_git_info(user)
        git_token = git_info["git_token"]
        git_domain = git_info["git_domain"]
        
        if not git_token:
            raise HTTPException(
                status_code=400,
                detail="Git token not configured"
            )

        # Get API base URL based on git domain
        api_base_url = self._get_api_base_url(git_domain)

        # Check if it's a default request (page=1, limit=100)
        is_default_request = page == 1 and limit == 100
        
        # For default requests, try to get from cache first
        if is_default_request:
            cache_key = cache_manager.generate_cache_key(user.id, git_domain, page, limit)
            cached_result = await cache_manager.get(cache_key)
            if cached_result:
                return [Repository(**repo).model_dump() for repo in cached_result]
        
        # Check if there is complete cached data
        full_cached = await self._get_all_repositories_from_cache(user, git_domain)
        if full_cached:
            # Paginate the cached data
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
                ).model_dump() for repo in paginated_repos
            ]

        try:
            headers = {
                "Authorization": f"Bearer {git_token}",
                "Accept": "application/json"
            }
            
            response = requests.get(
                f"{api_base_url}/projects",
                headers=headers,
                params={
                    "per_page": limit,
                    "page": page,
                    "order_by": "last_activity_at",
                    "membership": "true"
                }
            )
            response.raise_for_status()
            
            repos = response.json()
            
            # If it's a default request and the number of retrieved repos is less than limit, cache the results
            if is_default_request and len(repos) < limit:
                cache_key = cache_manager.generate_cache_key(user.id, git_domain, page, limit)
                await cache_manager.set(cache_key, repos, expire=settings.REPO_CACHE_EXPIRED_TIME)

                cache_key = cache_manager.generate_full_cache_key(user.id, git_domain)
                await cache_manager.set(cache_key, repos, expire=settings.REPO_CACHE_EXPIRED_TIME)
            
            # If it's a default request and the number of retrieved repos equals limit, start async full retrieval
            if is_default_request and len(repos) == limit:
                # Start async background task to fetch all repositories
                asyncio.create_task(self._fetch_all_repositories_async(user, git_token, git_domain))
            
            return [
                Repository(
                    id=repo["id"],
                    name=repo["name"],
                    full_name=repo["path_with_namespace"],
                    clone_url=repo["http_url_to_repo"],
                    private=repo["visibility"] == "private"
                ).model_dump() for repo in repos
            ]
        except requests.exceptions.RequestException as e:
            raise HTTPException(
                status_code=502,
                detail=f"GitLab API error: {str(e)}"
            )
    
    async def get_branches(
        self,
        user: User,
        repo_name: str
    ) -> List[Dict[str, Any]]:
        """
        Get branch list for specified repository
        
        Args:
            user: User object
            repo_name: Repository name
            
        Returns:
            Branch list
            
        Raises:
            HTTPException: Raised when retrieval fails
        """
        git_info = self._get_git_info(user)
        git_token = git_info["git_token"]
        git_domain = git_info["git_domain"]
        
        if not git_token:
            raise HTTPException(
                status_code=400,
                detail="Git token not configured"
            )

        # Get API base URL based on git domain
        api_base_url = self._get_api_base_url(git_domain)

        try:
            headers = {
                "Authorization": f"Bearer {git_token}",
                "Accept": "application/json"
            }
            
            # First, get the project ID from the repo name
            encoded_repo_name = repo_name.replace("/", "%2F")
            
            all_branches = []
            page = 1
            per_page = 100
            
            while True:
                response = requests.get(
                    f"{api_base_url}/projects/{encoded_repo_name}/repository/branches",
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
                ).model_dump() for branch in all_branches
            ]
        except requests.exceptions.RequestException as e:
            raise HTTPException(
                status_code=502,
                detail=f"GitLab API error: {str(e)}"
            )
    
    def validate_token(
        self,
        token: str,
        git_domain: str = None
    ) -> Dict[str, Any]:
        """
        Validate GitLab token
        
        Args:
            token: GitLab token
            git_domain: Custom GitLab domain (e.g., gitlab.com, git.example.com)
            
        Returns:
            Validation result including validity, user information, etc.
            
        Raises:
            HTTPException: Raised when validation fails
        """
        if not token:
            raise HTTPException(
                status_code=400,
                detail="Git token is required"
            )

        # Use custom domain if provided, otherwise use default
        api_base_url = self._get_api_base_url(git_domain)

        try:
            headers = {
                "Authorization": f"Bearer {token}",
                "Accept": "application/json"
            }
            
            response = requests.get(
                f"{api_base_url}/user",
                headers=headers
            )
            
            if response.status_code == 401:
                self.logger.warning(f"GitLab token validation failed: 401 Unauthorized")
                return {
                    "valid": False,
                }
            
            response.raise_for_status()
            
            user_data = response.json()
            
            return {
                "valid": True,
                "user": {
                    "id": user_data["id"],
                    "login": user_data["username"],
                    "name": user_data.get("name"),
                    "avatar_url": user_data.get("avatar_url")
                }
            }
            
        except requests.exceptions.RequestException as e:
            self.logger.error(f"GitLab API request failed: {str(e)}")
            if "401" in str(e):
                raise HTTPException(
                    status_code=401,
                    detail="Invalid GitLab token"
                )
            raise HTTPException(
                status_code=502,
                detail=f"GitLab API error: {str(e)}"
            )
        except Exception as e:
            self.logger.error(f"Unexpected error during token validation: {str(e)}")
            raise HTTPException(
                status_code=500,
                detail=f"Token validation failed: {str(e)}"
            )
    
    async def search_repositories(
        self,
        user: User,
        query: str,
        timeout: int = 30
    ) -> List[Dict[str, Any]]:
        """
        Search user's GitLab repositories
        
        Args:
            user: User object
            query: Search keyword
            timeout: Timeout in seconds
            
        Returns:
            Search results
            
        Raises:
            HTTPException: Raised when search fails
        """
        git_info = self._get_git_info(user)
        git_token = git_info["git_token"]
        git_domain = git_info["git_domain"]
        
        if not git_token:
            raise HTTPException(
                status_code=400,
                detail="Git token not configured"
            )
        
        # Normalize query, case-insensitive
        query_lower = query.lower()
        
        # Try to get from full cache first
        full_cached = await self._get_all_repositories_from_cache(user, git_domain)
        
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
                ).model_dump() for repo in filtered_repos
            ]
        
        # Check if cache is being built
        is_building = await cache_manager.is_building(user.id, git_domain)
        
        if is_building:
            # Wait for cache build to complete, set timeout
            start_time = asyncio.get_event_loop().time()
            while await cache_manager.is_building(user.id, git_domain):
                if asyncio.get_event_loop().time() - start_time > timeout:
                    raise HTTPException(
                        status_code=408,
                        detail="Timeout waiting for repository data to be ready"
                    )
                await asyncio.sleep(1)
            
            # Now try to get from cache again
            full_cached = await self._get_all_repositories_from_cache(user, git_domain)
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
                    ).model_dump() for repo in filtered_repos
                ]
        
        # No cache and not building, trigger full retrieval
        await self._fetch_all_repositories_async(user, git_token, git_domain)
        
        # Get again after cache is built
        full_cached = await self._get_all_repositories_from_cache(user, git_domain)
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
                ).model_dump() for repo in filtered_repos
            ]
        
        # Fallback: get current page
        repos = await self.get_repositories(user, page=1, limit=100)
        return [repo for repo in repos if query_lower in repo["name"].lower() or query_lower in repo["full_name"].lower()]
    
    async def _fetch_all_repositories_async(
        self,
        user: User,
        git_token: str = None,
        git_domain: str = None
    ) -> None:
        """
        Asynchronously fetch all user's GitLab repositories and cache them
        
        Args:
            user: User object
            git_token: Git token, if None then get from user's git_info
            git_domain: Git domain, if None then get from user's git_info
        """
        # If git_token or git_domain not provided, get from user's git_info
        if git_token is None or git_domain is None:
            git_info = self._get_git_info(user)
            git_token = git_info["git_token"] if git_token is None else git_token
            git_domain = git_info["git_domain"] if git_domain is None else git_domain
        
        # Check if already building
        if await cache_manager.is_building(user.id, git_domain):
            return
        
        await cache_manager.set_building(user.id, git_domain, True)
        
        try:
            headers = {
                "Authorization": f"Bearer {git_token}",
                "Accept": "application/json"
            }
            
            # Get API base URL based on git domain
            api_base_url = self._get_api_base_url(git_domain)
            
            headers = {
                "Authorization": f"Bearer {git_token}",
                "Accept": "application/json"
            }
            
            all_repos = []
            page = 1
            per_page = 100
            
            self.logger.info(f"Fetching repositories for user {user.user_name}")
            
            while True:
                response = requests.get(
                    f"{api_base_url}/projects",
                    headers=headers,
                    params={
                        "per_page": per_page,
                        "page": page,
                        "order_by": "last_activity_at",
                        "membership": "true"
                    }
                )
                response.raise_for_status()
                
                repos = response.json()
                if not repos:
                    break
                    
                # Map GitLab API response to standard format
                mapped_repos = [{
                    "id": repo["id"],
                    "name": repo["name"],
                    "full_name": repo["path_with_namespace"],
                    "clone_url": repo["http_url_to_repo"],
                    "private": repo["visibility"] == "private"
                } for repo in repos]
                all_repos.extend(mapped_repos)
                
                # If the number of retrieved repos is less than per_page, we've reached the end
                if len(repos) < per_page:
                    break
                    
                page += 1
                
                # Prevent infinite loop, set maximum page limit
                if page > 50:  # Maximum 5000 repositories
                    self.logger.warning(f"Reached maximum page limit (50) for user {user.id}")
                    break
            
            # Cache complete repository list
            cache_key = cache_manager.generate_full_cache_key(user.id, git_domain)
            await cache_manager.set(cache_key, all_repos, expire=settings.REPO_CACHE_EXPIRED_TIME)
            
        except Exception:
            # Background task fails silently
            self.logger.error(f"Failed to fetch repositories for user {user.user_name}")
            pass
        finally:
            # Always clear build status
            await cache_manager.set_building(user.id, git_domain, False)
            self.logger.info(f"Repository fetch completed for user {user.user_name}")
    
    async def _get_all_repositories_from_cache(
        self,
        user: User,
        git_domain: str = None
    ) -> Optional[List[Dict[str, Any]]]:
        """
        Get all repositories from cache
        
        Args:
            user: User object
            git_domain: Git domain, if None then use domain from user's git_info
            
        Returns:
            Cached repository list, returns None if no cache
        """
        if git_domain is None:
            git_info = self._get_git_info(user)
            git_domain = git_info["git_domain"]
            
        cache_key = cache_manager.generate_full_cache_key(user.id, git_domain)
        return await cache_manager.get(cache_key)
    
    def get_repo_id_by_fullname(
        self,
        user: User,
        fullname: str
    ) -> Optional[int]:
        """
        Get repository ID by its full name (e.g., 'username/repo')
        
        Args:
            user: User object
            fullname: Full name of the repository (username/repo)
            
        Returns:
            Repository ID if found, None otherwise
            
        Raises:
            HTTPException: Raised when API call fails
        """
        if not fullname:
            return None
            
        git_info = self._get_git_info(user)
        git_token = git_info["git_token"]
        git_domain = git_info["git_domain"]
        
        if not git_token:
            return None
        
        # Get API base URL based on git domain
        api_base_url = self._get_api_base_url(git_domain)
        
        try:
            headers = {
                "Authorization": f"Bearer {git_token}",
                "Accept": "application/json"
            }
            
            # Encode the full name for URL
            encoded_fullname = fullname.replace("/", "%2F")
            
            response = requests.get(
                f"{api_base_url}/projects/{encoded_fullname}",
                headers=headers
            )
            
            if response.status_code == 404:
                return None
                
            response.raise_for_status()
            
            repo_data = response.json()
            return repo_data.get("id")
            
        except requests.exceptions.RequestException:
            return None