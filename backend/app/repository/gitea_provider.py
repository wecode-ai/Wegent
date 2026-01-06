# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Gitea repository provider implementation
"""
import asyncio
import logging
from functools import lru_cache
from typing import Any, Dict, List, Optional

import requests
from fastapi import HTTPException
from shared.utils.sensitive_data_masker import mask_string
from shared.utils.url_util import build_url

from app.core.cache import cache_manager
from app.core.config import settings
from app.models.user import User
from app.repository.interfaces.repository_provider import RepositoryProvider
from app.schemas.github import Branch, Repository


class GiteaProvider(RepositoryProvider):
    """
    Gitea repository provider implementation
    """

    def __init__(self):
        self.logger = logging.getLogger(__name__)
        self.api_base_url = "https://gitea.com/api/v1"
        self.domain = "gitea.com"
        self.type = "gitea"

    def _get_git_infos(
        self, user: User, git_domain: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        """
        Collect Gitea related entries from user's git_info (may contain multiple entries)

        Args:
            user: User object
            git_domain: Optional domain to filter a specific Gitea entry

        Returns:
            List of dictionaries containing git_domain, git_token, type, user_name

        Raises:
            HTTPException: Raised when Gitea information is not configured
        """
        if not user.git_info:
            raise HTTPException(
                status_code=400, detail="Git information not configured"
            )

        entries: List[Dict[str, Any]] = []
        for info in user.git_info:
            if info.get("type") == self.type:
                entries.append(
                    {
                        "git_domain": info.get("git_domain", ""),
                        "git_token": info.get("git_token", ""),
                        "type": info.get("type", ""),
                        "user_name": info.get("user_name", ""),
                    }
                )

        if git_domain:
            filtered = [e for e in entries if e.get("git_domain") == git_domain]
            if not filtered:
                raise HTTPException(
                    status_code=400,
                    detail=f"Git information for {git_domain} not configured",
                )
            return filtered

        if not entries:
            raise HTTPException(
                status_code=400,
                detail=f"Git information for {self.domain} not configured",
            )
        return entries

    def _pick_git_info(self, user: User, git_domain: str) -> Dict[str, Any]:
        """
        Pick a single git_info entry based on domain or default to the first
        """
        entries = self._get_git_infos(user, git_domain)
        return entries[0]

    def _get_api_base_url(self, git_domain: str = None) -> str:
        """Get API base URL based on git domain"""
        if not git_domain or git_domain == self.domain:
            return self.api_base_url

        if git_domain == "gitea.com":
            return "https://gitea.com/api/v1"
        else:
            # Custom self-hosted Gitea domain (may include http:// protocol)
            return build_url(git_domain, "/api/v1")

    def _build_headers(self, token: str) -> Dict[str, str]:
        return {
            "Authorization": f"token {token}",
            "Accept": "application/json",
        }

    async def get_repositories(
        self, user: User, page: int = 1, limit: int = 100
    ) -> List[Dict[str, Any]]:
        """
        Get user's Gitea repository list

        Args:
            user: User object
            page: Page number
            limit: Items per page

        Returns:
            Repository list

        Raises:
            HTTPException: Raised when retrieval fails
        """
        entries = self._get_git_infos(user)
        all_repos: List[Dict[str, Any]] = []

        for entry in entries:
            git_token = entry.get("git_token") or ""
            git_domain = entry.get("git_domain") or ""
            if not git_token:
                continue

            api_base_url = self._get_api_base_url(git_domain)

            full_cached = await self._get_all_repositories_from_cache(user, git_domain)
            if full_cached:
                start_idx = (page - 1) * limit
                end_idx = start_idx + limit
                paginated_repos = full_cached[start_idx:end_idx]
                all_repos.extend(
                    [
                        Repository(
                            id=repo["id"],
                            name=repo["name"],
                            full_name=repo.get("full_name", repo.get("name", "")),
                            clone_url=repo.get("clone_url") or repo.get("html_url", ""),
                            git_domain=git_domain,
                            type=self.type,
                            private=repo.get("private", False),
                        ).model_dump()
                        for repo in paginated_repos
                    ]
                )
                continue

            try:
                headers = self._build_headers(git_token)
                response = requests.get(
                    f"{api_base_url}/user/repos",
                    headers=headers,
                    params={"limit": limit, "page": page, "sort": "updated"},
                )
                response.raise_for_status()

                repos = response.json()
                mapped_repos = [
                    {
                        "id": repo.get("id"),
                        "name": repo.get("name", ""),
                        "full_name": repo.get("full_name", repo.get("name", "")),
                        "clone_url": repo.get("clone_url") or repo.get("html_url", ""),
                        "git_domain": git_domain,
                        "type": self.type,
                        "private": repo.get("private", False),
                    }
                    for repo in repos
                ]

                # Check X-Total-Count header to determine if we have all repos
                # Gitea servers may limit response to MAX_RESPONSE_ITEMS (default 50)
                total_count = response.headers.get("X-Total-Count")
                has_more = False
                if total_count:
                    try:
                        total = int(total_count)
                        has_more = len(mapped_repos) < total
                    except (ValueError, TypeError):
                        # Malformed header, fall back to default logic
                        has_more = len(mapped_repos) >= limit
                else:
                    # Fall back to comparing with requested limit
                    has_more = len(mapped_repos) >= limit

                if not has_more:
                    cache_key = cache_manager.generate_full_cache_key(
                        user.id, git_domain
                    )
                    await cache_manager.set(
                        cache_key,
                        mapped_repos,
                        expire=settings.REPO_CACHE_EXPIRED_TIME,
                    )
                else:
                    asyncio.create_task(
                        self._fetch_all_repositories_async(user, git_token, git_domain)
                    )

                all_repos.extend(
                    [
                        Repository(
                            id=repo["id"],
                            name=repo["name"],
                            full_name=repo.get("full_name", ""),
                            clone_url=repo.get("clone_url", ""),
                            git_domain=git_domain,
                            type=self.type,
                            private=repo.get("private", False),
                        ).model_dump()
                        for repo in mapped_repos
                    ]
                )
            except requests.exceptions.RequestException:
                continue

        return all_repos

    async def get_branches(
        self, user: User, repo_name: str, git_domain: str
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
        git_info = self._pick_git_info(user, git_domain)
        git_token = git_info["git_token"]
        git_domain = git_info["git_domain"]
        user_name = git_info.get("user_name", "")

        if not git_token:
            raise HTTPException(status_code=400, detail="Git token not configured")

        api_base_url = self._get_api_base_url(git_domain)

        try:
            headers = self._build_headers(git_token)

            default_branch_name = self._get_default_branch(
                repo_name, git_domain, git_token
            )

            all_branches = []
            page = 1
            per_page = 100

            while True:
                response = requests.get(
                    f"{api_base_url}/repos/{repo_name}/branches",
                    headers=headers,
                    params={"limit": per_page, "page": page},
                )
                response.raise_for_status()

                branches = response.json()
                if not branches:
                    break

                all_branches.extend(branches)
                page += 1

                if page > 50:
                    break

            return [
                Branch(
                    name=branch["name"],
                    protected=branch.get("protected", False),
                    default=branch.get("default", False)
                    or branch["name"] == default_branch_name,
                ).model_dump()
                for branch in all_branches
            ]
        except requests.exceptions.RequestException as e:
            raise HTTPException(status_code=502, detail=f"Gitea API error: {str(e)}")

    @lru_cache(maxsize=100)
    def _get_default_branch(
        self, repo_name: str, git_domain: str, git_token: str
    ) -> str:
        api_base_url = self._get_api_base_url(git_domain)
        headers = self._build_headers(git_token)

        try:
            response = requests.get(
                f"{api_base_url}/repos/{repo_name}", headers=headers
            )
            response.raise_for_status()

            repo_data = response.json()
            return repo_data.get("default_branch", "main")
        except requests.exceptions.RequestException as e:
            self.logger.warning(
                f"Failed to get default branch for {repo_name}: {str(e)}"
            )
            return "main"
        except (ValueError, KeyError) as e:
            self.logger.warning(
                f"Failed to parse default branch for {repo_name}: {str(e)}"
            )
            return "main"

    def validate_token(self, token: str, git_domain: str = None) -> Dict[str, Any]:
        """
        Validate Gitea token

        Args:
            token: Gitea token
            git_domain: Custom Gitea domain

        Returns:
            Validation result including validity, user information, etc.

        Raises:
            HTTPException: Raised when validation fails
        """
        if not token:
            raise HTTPException(status_code=400, detail="Git token is required")

        api_base_url = self._get_api_base_url(git_domain)

        decrypt_token = self.decrypt_token(token)
        headers = self._build_headers(decrypt_token)
        try:
            response = requests.get(f"{api_base_url}/user", headers=headers)

            if response.status_code == 401:
                self.logger.warning(
                    f"Gitea token validation failed: 401 Unauthorized, git_domain: {git_domain}, token: {mask_string(token)}"
                )
                return {
                    "valid": False,
                }

            response.raise_for_status()

            user_data = response.json()

            return {
                "valid": True,
                "user": {
                    "id": user_data.get("id"),
                    "login": user_data.get("login"),
                    "name": user_data.get("full_name") or user_data.get("username"),
                    "avatar_url": user_data.get("avatar_url"),
                    "email": user_data.get("email"),
                },
            }

        except requests.exceptions.RequestException as e:
            self.logger.error(f"Gitea API request failed: {str(e)}")
            if "401" in str(e):
                raise HTTPException(status_code=401, detail="Invalid Gitea token")
            raise HTTPException(status_code=502, detail=f"Gitea API error: {str(e)}")
        except Exception as e:
            self.logger.error(f"Unexpected error during token validation: {str(e)}")
            raise HTTPException(
                status_code=500, detail=f"Token validation failed: {str(e)}"
            )

    async def search_repositories(
        self, user: User, query: str, timeout: int = 30, fullmatch: bool = False
    ) -> List[Dict[str, Any]]:
        """
        Search user's Gitea repositories across all configured Gitea domains

        Args:
            user: User object
            query: Search keyword
            timeout: Timeout in seconds
            fullmatch: Enable exact match (true) or partial match (false)

        Returns:
            Aggregated search results from all configured Gitea domains

        Raises:
            HTTPException: Raised when search fails
        """
        query_lower = query.lower()

        entries = self._get_git_infos(user)
        all_results: List[Dict[str, Any]] = []

        for entry in entries:
            git_token = entry.get("git_token") or ""
            git_domain = entry.get("git_domain") or ""
            if not git_token:
                continue

            full_cached = await self._get_all_repositories_from_cache(user, git_domain)
            if full_cached:
                if fullmatch:
                    filtered_repos = [
                        repo
                        for repo in full_cached
                        if query_lower == repo["name"].lower()
                        or query_lower == repo["full_name"].lower()
                    ]
                else:
                    filtered_repos = [
                        repo
                        for repo in full_cached
                        if query_lower in repo["name"].lower()
                        or query_lower in repo["full_name"].lower()
                    ]
                all_results.extend(
                    [
                        Repository(
                            id=repo["id"],
                            name=repo["name"],
                            full_name=repo["full_name"],
                            clone_url=repo["clone_url"],
                            git_domain=git_domain,
                            type=self.type,
                            private=repo.get("private", False),
                        ).model_dump()
                        for repo in filtered_repos
                    ]
                )
                continue

            is_building = await cache_manager.is_building(user.id, git_domain)
            if is_building:
                start_time = asyncio.get_event_loop().time()
                while await cache_manager.is_building(user.id, git_domain):
                    if asyncio.get_event_loop().time() - start_time > timeout:
                        raise HTTPException(
                            status_code=408,
                            detail="Timeout waiting for repository data to be ready",
                        )
                    await asyncio.sleep(1)

                full_cached = await self._get_all_repositories_from_cache(
                    user, git_domain
                )
                if full_cached:
                    if fullmatch:
                        filtered_repos = [
                            repo
                            for repo in full_cached
                            if query_lower == repo["name"].lower()
                            or query_lower == repo["full_name"].lower()
                        ]
                    else:
                        filtered_repos = [
                            repo
                            for repo in full_cached
                            if query_lower in repo["name"].lower()
                            or query_lower in repo["full_name"].lower()
                        ]
                    all_results.extend(
                        [
                            Repository(
                                id=repo["id"],
                                name=repo["name"],
                                full_name=repo["full_name"],
                                clone_url=repo["clone_url"],
                                git_domain=git_domain,
                                type=self.type,
                                private=repo.get("private", False),
                            ).model_dump()
                            for repo in filtered_repos
                        ]
                    )
                    continue

            await self._fetch_all_repositories_async(user, git_token, git_domain)

            full_cached = await self._get_all_repositories_from_cache(user, git_domain)
            if full_cached:
                if fullmatch:
                    filtered_repos = [
                        repo
                        for repo in full_cached
                        if query_lower == repo["name"].lower()
                        or query_lower == repo["full_name"].lower()
                    ]
                else:
                    filtered_repos = [
                        repo
                        for repo in full_cached
                        if query_lower in repo["name"].lower()
                        or query_lower in repo["full_name"].lower()
                    ]
                all_results.extend(
                    [
                        Repository(
                            id=repo["id"],
                            name=repo["name"],
                            full_name=repo["full_name"],
                            clone_url=repo["clone_url"],
                            git_domain=git_domain,
                            type=self.type,
                            private=repo.get("private", False),
                        ).model_dump()
                        for repo in filtered_repos
                    ]
                )
                continue

            try:
                api_base_url = self._get_api_base_url(git_domain)
                headers = self._build_headers(git_token)
                response = requests.get(
                    f"{api_base_url}/user/repos",
                    headers=headers,
                    params={"limit": 100, "page": 1, "sort": "updated"},
                )
                response.raise_for_status()
                repos = response.json()
                mapped = [
                    {
                        "id": repo["id"],
                        "name": repo["name"],
                        "full_name": repo.get("full_name", repo.get("name", "")),
                        "clone_url": repo.get("clone_url") or repo.get("html_url", ""),
                        "git_domain": git_domain,
                        "type": self.type,
                        "private": repo.get("private", False),
                    }
                    for repo in repos
                ]
                if fullmatch:
                    filtered_repos = [
                        r
                        for r in mapped
                        if query_lower == r["name"].lower()
                        or query_lower == r["full_name"].lower()
                    ]
                else:
                    filtered_repos = [
                        r
                        for r in mapped
                        if query_lower in r["name"].lower()
                        or query_lower in r["full_name"].lower()
                    ]
                all_results.extend(
                    [
                        Repository(
                            id=r["id"],
                            name=r["name"],
                            full_name=r["full_name"],
                            clone_url=r["clone_url"],
                            git_domain=git_domain,
                            type=self.type,
                            private=r.get("private", False),
                        ).model_dump()
                        for r in filtered_repos
                    ]
                )
            except requests.exceptions.RequestException:
                continue

        return all_results

    async def _fetch_all_repositories_async(
        self, user: User, git_token: str, git_domain: str
    ) -> None:
        """
        Asynchronously fetch all user's Gitea repositories and cache them

        Args:
            user: User object
            git_token: Git token
            git_domain: Git domain
        """

        if await cache_manager.is_building(user.id, git_domain):
            return

        await cache_manager.set_building(user.id, git_domain, True)

        try:
            api_base_url = self._get_api_base_url(git_domain)
            headers = self._build_headers(git_token)

            all_repos = []
            page = 1
            # Gitea servers may have MAX_RESPONSE_ITEMS configured (default 50)
            # We request 50 to be safe and rely on pagination
            per_page = 50

            self.logger.info(
                f"Fetching gitea all repositories for user {user.user_name}"
            )

            while True:
                response = await asyncio.to_thread(
                    requests.get,
                    f"{api_base_url}/user/repos",
                    headers=headers,
                    params={"limit": per_page, "page": page, "sort": "updated"},
                )
                response.raise_for_status()

                repos = response.json()
                if not repos:
                    break

                mapped_repos = [
                    {
                        "id": repo["id"],
                        "name": repo["name"],
                        "full_name": repo.get("full_name", repo.get("name", "")),
                        "clone_url": repo.get("clone_url") or repo.get("html_url", ""),
                        "git_domain": git_domain,
                        "type": self.type,
                        "private": repo.get("private", False),
                    }
                    for repo in repos
                ]
                all_repos.extend(mapped_repos)

                # Check if there are more pages using X-Total-Count header
                # or fall back to checking if we got fewer items than requested
                total_count = response.headers.get("X-Total-Count")
                if total_count:
                    try:
                        total = int(total_count)
                        if len(all_repos) >= total:
                            break
                    except (ValueError, TypeError):
                        # Malformed header, fall back to checking response size
                        if len(repos) < per_page:
                            break
                elif len(repos) < per_page:
                    # No header available, fall back to old logic
                    break

                page += 1

                if page > 100:
                    self.logger.warning(
                        f"Reached maximum page limit (100) for user {user.id}"
                    )
                    break

            cache_key = cache_manager.generate_full_cache_key(user.id, git_domain)
            await cache_manager.set(
                cache_key, all_repos, expire=settings.REPO_CACHE_EXPIRED_TIME
            )
            self.logger.info(
                f"Cache complete repository list for user gitea {user.user_name}"
            )

        except Exception as e:
            self.logger.error(
                f"Failed to fetch gitea repositories for user {user.user_name}: {str(e)}"
            )
        finally:
            await cache_manager.set_building(user.id, git_domain, False)
            self.logger.info(f"Repository fetch completed for user {user.user_name}")

    async def _get_all_repositories_from_cache(
        self, user: User, git_domain: str
    ) -> Optional[List[Dict[str, Any]]]:
        """
        Get all repositories from cache

        Args:
            user: User object
            git_domain: Git domain

        Returns:
            Cached repository list, returns None if no cache
        """
        if git_domain is None:
            git_info = self._pick_git_info(user, git_domain)
            git_domain = git_info["git_domain"]

        cache_key = cache_manager.generate_full_cache_key(user.id, git_domain)
        return await cache_manager.get(cache_key)

    async def get_branch_diff(
        self,
        user: User,
        repo_name: str,
        source_branch: str,
        target_branch: str,
        git_domain: str,
    ) -> Dict[str, Any]:
        """
        Get diff between two branches for a Gitea repository

        Args:
            user: User object
            repo_name: Repository name
            source_branch: Source branch name (the branch with changes)
            target_branch: Target branch name (the branch to compare against)
            git_domain: Git domain

        Returns:
            Diff information including files changed and diff content
        """
        git_info = self._pick_git_info(user, git_domain)
        git_token = git_info["git_token"]
        user_name = git_info.get("user_name", "")

        if not git_token:
            raise HTTPException(status_code=400, detail="Git token not configured")

        api_base_url = self._get_api_base_url(git_domain)
        headers = self._build_headers(git_token)

        try:
            self.logger.info(
                f"Comparing {repo_name}: {target_branch}...{source_branch}"
            )
            response = requests.get(
                f"{api_base_url}/repos/{repo_name}/compare/{target_branch}...{source_branch}",
                headers=headers,
            )
            response.raise_for_status()

            compare_data = response.json()

            files = []
            for file in compare_data.get("files", []):
                file_info = {
                    "filename": file.get("filename", ""),
                    "status": file.get("status", ""),
                    "additions": file.get("additions", 0),
                    "deletions": file.get("deletions", 0),
                    "changes": file.get("changes", 0),
                    "patch": file.get("patch", ""),
                    "previous_filename": file.get("previous_filename", ""),
                    "blob_url": file.get("blob_url", ""),
                    "raw_url": file.get("raw_url", ""),
                    "contents_url": file.get("contents_url", ""),
                }
                files.append(file_info)

            commits = compare_data.get("commits", [])
            total_commits = compare_data.get("total_commits", len(commits))

            return {
                "status": compare_data.get(
                    "status", "ahead" if total_commits else "identical"
                ),
                "ahead_by": compare_data.get("ahead_by", total_commits),
                "behind_by": compare_data.get("behind_by", 0),
                "total_commits": total_commits,
                "files": files,
                "diff_url": compare_data.get("diff_url", ""),
                "html_url": compare_data.get("html_url", ""),
                "permalink_url": compare_data.get("permalink_url", ""),
            }

        except requests.exceptions.RequestException as e:
            raise HTTPException(status_code=502, detail=f"Gitea API error: {str(e)}")

    def check_user_project_access(
        self,
        token: str,
        git_domain: str,
        repo_name: str,
    ) -> Dict[str, Any]:
        """
        Check if a user has access to a specific Gitea repository.

        Args:
            token: Gitea access token
            git_domain: Gitea domain
            repo_name: Repository full name (e.g., "owner/repo")

        Returns:
            Dictionary with access information
        """
        api_base_url = self._get_api_base_url(git_domain)
        decrypt_token = self.decrypt_token(token)
        headers = self._build_headers(decrypt_token)

        try:
            user_response = requests.get(f"{api_base_url}/user", headers=headers)
            if user_response.status_code == 401:
                return {
                    "has_access": False,
                    "access_level": 0,
                    "access_level_name": "No Access",
                    "username": "",
                    "error": "Invalid token",
                }
            user_response.raise_for_status()
            user_data = user_response.json()
            username = user_data.get("login", "") or user_data.get("username", "")
        except requests.exceptions.RequestException as e:
            self.logger.error(f"Failed to get user info from Gitea: {str(e)}")
            raise HTTPException(status_code=502, detail=f"Gitea API error: {str(e)}")

        try:
            repo_response = requests.get(
                f"{api_base_url}/repos/{repo_name}", headers=headers
            )
            if repo_response.status_code == 404:
                return {
                    "has_access": False,
                    "access_level": 0,
                    "access_level_name": "No Access",
                    "username": username,
                }

            repo_response.raise_for_status()
            repo_data = repo_response.json()
            permissions = repo_data.get("permissions", {})

            permission_mapping = {
                "admin": (50, "Admin"),
                "write": (30, "Developer"),
                "push": (30, "Developer"),
                "read": (10, "Read"),
                "pull": (10, "Read"),
            }

            access_level = 0
            access_level_name = "No Access"

            if permissions.get("admin"):
                access_level, access_level_name = permission_mapping["admin"]
            elif permissions.get("push") or permissions.get("write"):
                access_level, access_level_name = permission_mapping["push"]
            elif permissions.get("pull") or permissions.get("read"):
                access_level, access_level_name = permission_mapping["pull"]

            return {
                "has_access": access_level > 0,
                "access_level": access_level,
                "access_level_name": access_level_name,
                "username": username,
            }
        except requests.exceptions.RequestException as e:
            self.logger.error(f"Failed to check Gitea repository access: {str(e)}")
            raise HTTPException(status_code=502, detail=f"Gitea API error: {str(e)}")
