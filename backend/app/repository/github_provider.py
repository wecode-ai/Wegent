# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
GitHub repository provider implementation
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


class GitHubProvider(RepositoryProvider):
    """
    GitHub repository provider implementation
    """

    def __init__(self):
        self.logger = logging.getLogger(__name__)
        self.api_base_url = "https://api.github.com"
        self.domain = "github.com"
        self.type = "github"

    def _get_git_infos(
        self, user: User, git_domain: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        """
        Collect GitHub related entries from user's git_info (may contain multiple entries)

        Args:
            user: User object
            git_domain: Optional domain to filter a specific GitHub/GHE entry

        Returns:
            List of dictionaries containing git_domain, git_token, type

        Raises:
            HTTPException: Raised when GitHub information is not configured
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

        if git_domain == "github.com":
            return "https://api.github.com"
        else:
            # Custom GitHub Enterprise domain (may include http:// protocol)
            return build_url(git_domain, "/api/v3")

    async def get_repositories(
        self, user: User, page: int = 1, limit: int = 100
    ) -> List[Dict[str, Any]]:
        """
        Get user's GitHub repository list

        Args:
            user: User object
            page: Page number
            limit: Items per page

        Returns:
            Repository list

        Raises:
            HTTPException: Raised when retrieval fails
        """
        # iterate all github entries for this user (may be multiple domains)
        entries = self._get_git_infos(user)
        all_repos: List[Dict[str, Any]] = []

        for entry in entries:
            git_token = entry.get("git_token") or ""
            git_domain = entry.get("git_domain") or ""
            if not git_token:
                # skip empty token entries
                continue

            # Get API base URL based on git domain
            api_base_url = self._get_api_base_url(git_domain)

            # Check domain-level full cache
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
                            full_name=repo["full_name"],
                            clone_url=repo["clone_url"],
                            git_domain=git_domain,
                            type="github",
                            private=repo["private"],
                        ).model_dump()
                        for repo in paginated_repos
                    ]
                )
                continue

            try:
                headers = {
                    "Authorization": f"token {git_token}",
                    "Accept": "application/vnd.github.v3+json",
                }

                response = requests.get(
                    f"{api_base_url}/user/repos",
                    headers=headers,
                    params={"per_page": limit, "page": page, "sort": "updated"},
                )
                response.raise_for_status()

                repos = response.json()

                if len(repos) < limit:
                    cache_key = cache_manager.generate_full_cache_key(
                        user.id, git_domain
                    )
                    await cache_manager.set(
                        cache_key, repos, expire=settings.REPO_CACHE_EXPIRED_TIME
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
                            full_name=repo["full_name"],
                            clone_url=repo["clone_url"],
                            git_domain=git_domain,
                            type="github",
                            private=repo["private"],
                        ).model_dump()
                        for repo in repos
                    ]
                )
            except requests.exceptions.RequestException:
                # skip failed domain, continue others
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

        if not git_token:
            raise HTTPException(status_code=400, detail="Git token not configured")

        # Get API base URL based on git domain
        api_base_url = self._get_api_base_url(git_domain)

        try:
            headers = {
                "Authorization": f"token {git_token}",
                "Accept": "application/vnd.github.v3+json",
            }

            # Get the actual default branch name
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
                    params={"per_page": per_page, "page": page},
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
                    or branch["name"] == default_branch_name,
                ).model_dump()
                for branch in all_branches
            ]
        except requests.exceptions.RequestException as e:
            raise HTTPException(status_code=502, detail=f"GitHub API error: {str(e)}")

    @lru_cache(maxsize=100)
    def _get_default_branch(
        self, repo_name: str, git_domain: str, git_token: str
    ) -> str:

        api_base_url = self._get_api_base_url(git_domain)

        headers = {
            "Authorization": f"token {git_token}",
            "Accept": "application/vnd.github.v3+json",
        }

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
            # Fallback to common default branch names
            return "main"
        except (ValueError, KeyError) as e:
            self.logger.warning(
                f"Failed to parse default branch for {repo_name}: {str(e)}"
            )
            # Fallback to common default branch names
            return "main"

    def validate_token(self, token: str, git_domain: str = None) -> Dict[str, Any]:
        """
        Validate GitHub token

        Args:
            token: GitHub token
            git_domain: Custom GitHub domain (e.g., github.com, git.example.com)

        Returns:
            Validation result including validity, user information, etc.

        Raises:
            HTTPException: Raised when validation fails
        """
        if not token:
            raise HTTPException(status_code=400, detail="Git token is required")

        # Use custom domain if provided, otherwise use default
        api_base_url = self._get_api_base_url(git_domain)

        decrypt_token = self.decrypt_token(token)
        try:
            headers = {
                "Authorization": f"token {decrypt_token}",
                "Accept": "application/vnd.github.v3+json",
            }

            response = requests.get(f"{api_base_url}/user", headers=headers)

            if response.status_code == 401:
                self.logger.warning(
                    f"GitHub token validation failed: 401 Unauthorized, git_domain: {git_domain}, token: {mask_string(token)}"
                )
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
                    "avatar_url": user_data.get("avatar_url"),
                    "email": user_data.get("email"),
                },
            }

        except requests.exceptions.RequestException as e:
            self.logger.error(f"GitHub API request failed: {str(e)}")
            if "401" in str(e):
                raise HTTPException(status_code=401, detail="Invalid GitHub token")
            raise HTTPException(status_code=502, detail=f"GitHub API error: {str(e)}")
        except Exception as e:
            self.logger.error(f"Unexpected error during token validation: {str(e)}")
            raise HTTPException(
                status_code=500, detail=f"Token validation failed: {str(e)}"
            )

    async def search_repositories(
        self, user: User, query: str, timeout: int = 30, fullmatch: bool = False
    ) -> List[Dict[str, Any]]:
        """
        Search user's GitHub repositories across all configured GitHub domains

        Args:
            user: User object
            query: Search keyword
            timeout: Timeout in seconds
            fullmatch: Enable exact match (true) or partial match (false)

        Returns:
            Aggregated search results from all configured GitHub domains

        Raises:
            HTTPException: Raised when search fails
        """
        # Normalize query, case-insensitive
        query_lower = query.lower()

        # Iterate all github entries for this user (may be multiple domains)
        entries = self._get_git_infos(user)
        all_results: List[Dict[str, Any]] = []

        for entry in entries:
            git_token = entry.get("git_token") or ""
            git_domain = entry.get("git_domain") or ""
            if not git_token:
                # skip empty token entries
                continue

            # 1) Try to get from full cache first (per domain)
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
                            type="github",
                            private=repo["private"],
                        ).model_dump()
                        for repo in filtered_repos
                    ]
                )
                continue

            # 2) If cache is being built for this domain, wait (with timeout)
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

                # try cache again
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
                                type="github",
                                private=repo["private"],
                            ).model_dump()
                            for repo in filtered_repos
                        ]
                    )
                    continue

            # 3) No cache and not building (or build finished but still no cache), trigger domain-level full retrieval
            await self._fetch_all_repositories_async(user, git_token, git_domain)

            # 4) Try cache after building
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
                            type="github",
                            private=repo["private"],
                        ).model_dump()
                        for repo in filtered_repos
                    ]
                )
                continue

            # 5) Fallback: fetch first page for this domain only (avoid cross-domain aggregation)
            try:
                api_base_url = self._get_api_base_url(git_domain)
                headers = {
                    "Authorization": f"token {git_token}",
                    "Accept": "application/vnd.github.v3+json",
                }
                response = requests.get(
                    f"{api_base_url}/user/repos",
                    headers=headers,
                    params={"per_page": 100, "page": 1, "sort": "updated"},
                )
                response.raise_for_status()
                repos = response.json()
                mapped = [
                    {
                        "id": repo["id"],
                        "name": repo["name"],
                        "full_name": repo["full_name"],
                        "clone_url": repo["clone_url"],
                        "git_domain": git_domain,
                        "type": "github",
                        "private": repo["private"],
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
                            type="github",
                            private=r["private"],
                        ).model_dump()
                        for r in filtered_repos
                    ]
                )
            except requests.exceptions.RequestException:
                # skip this domain on error
                continue

        return all_results

    async def _fetch_all_repositories_async(
        self, user: User, git_token: str, git_domain: str
    ) -> None:
        """
        Asynchronously fetch all user's GitHub repositories and cache them

        Args:
            user: User object
            git_token: Git token, if None then get from user's git_info
            git_domain: Git domain, if None then get from user's git_info
        """

        # Check if already building
        if await cache_manager.is_building(user.id, git_domain):
            return

        await cache_manager.set_building(user.id, git_domain, True)

        try:
            # Get API base URL based on git domain
            api_base_url = self._get_api_base_url(git_domain)

            headers = {
                "Authorization": f"token {git_token}",
                "Accept": "application/vnd.github.v3+json",
            }

            all_repos = []
            page = 1
            per_page = 100

            self.logger.info(
                f"Fetching github all repositories for user {user.user_name}"
            )

            while True:
                response = await asyncio.to_thread(
                    requests.get,
                    f"{api_base_url}/user/repos",
                    headers=headers,
                    params={"per_page": per_page, "page": page, "sort": "updated"},
                )
                response.raise_for_status()

                repos = response.json()
                if not repos:
                    break

                # Map GitHub API response to standard format
                mapped_repos = [
                    {
                        "id": repo["id"],
                        "name": repo["name"],
                        "full_name": repo["full_name"],
                        "clone_url": repo["clone_url"],
                        "git_domain": git_domain,
                        "type": "github",
                        "private": repo["private"],
                    }
                    for repo in repos
                ]
                all_repos.extend(mapped_repos)

                # If the number of retrieved repos is less than per_page, we've reached the end
                if len(repos) < per_page:
                    break

                page += 1

                # Prevent infinite loop, set maximum page limit
                if page > 50:  # Maximum 5000 repositories
                    self.logger.warning(
                        f"Reached maximum page limit (50) for user {user.id}"
                    )
                    break

            # Cache complete repository list
            cache_key = cache_manager.generate_full_cache_key(user.id, git_domain)
            await cache_manager.set(
                cache_key, all_repos, expire=settings.REPO_CACHE_EXPIRED_TIME
            )
            self.logger.info(
                f"Cache complete repository list for user github {user.user_name}"
            )

        except Exception as e:
            # Background task fails silently
            self.logger.error(
                f"Failed to fetch github repositories for user {user.user_name}: {str(e)}"
            )
            pass
        finally:
            # Always clear build status
            await cache_manager.set_building(user.id, git_domain, False)
            self.logger.info(f"Repository fetch completed for user {user.user_name}")

    async def _get_all_repositories_from_cache(
        self, user: User, git_domain: str
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
        Get diff between two branches for a GitHub repository

        Args:
            user: User object
            repo_name: Repository name
            source_branch: Source branch name (the branch with changes, e.g., feature branch)
            target_branch: Target branch name (the branch to compare against, e.g., main)
            git_domain: Git domain

        Returns:
            Diff information including files changed and diff content
        """
        git_info = self._pick_git_info(user, git_domain)
        git_token = git_info["git_token"]

        if not git_token:
            raise HTTPException(status_code=400, detail="Git token not configured")

        # Get API base URL based on git domain
        api_base_url = self._get_api_base_url(git_domain)

        try:
            headers = {
                "Authorization": f"token {git_token}",
                "Accept": "application/vnd.github.v3+json",
            }

            # Get compare API response
            # GitHub API format: base...head
            # base = target_branch (what we're comparing against, e.g., main)
            # head = source_branch (what has the changes, e.g., feature branch)
            # This shows what changes are in source_branch that are not in target_branch
            self.logger.info(
                f"Comparing {repo_name}: {target_branch}...{source_branch}"
            )
            response = requests.get(
                f"{api_base_url}/repos/{repo_name}/compare/{target_branch}...{source_branch}",
                headers=headers,
            )
            response.raise_for_status()

            compare_data = response.json()

            # Log for debugging
            self.logger.info(
                f"Compare API response status: {compare_data.get('status', 'unknown')}"
            )
            self.logger.info(f"Total commits: {compare_data.get('total_commits', 0)}")
            self.logger.info(f"Files count: {len(compare_data.get('files', []))}")

            # Process files and their diffs
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

            # If no files found in the first direction, try the reverse direction
            if not files and compare_data.get("total_commits", 0) > 0:
                self.logger.info(
                    f"No files found in {target_branch}...{source_branch}, trying reverse direction"
                )
                reverse_response = requests.get(
                    f"{api_base_url}/repos/{repo_name}/compare/{source_branch}...{target_branch}",
                    headers=headers,
                )
                reverse_response.raise_for_status()
                reverse_data = reverse_response.json()

                self.logger.info(
                    f"Reverse compare API response status: {reverse_data.get('status', 'unknown')}"
                )
                self.logger.info(
                    f"Reverse total commits: {reverse_data.get('total_commits', 0)}"
                )
                self.logger.info(
                    f"Reverse files count: {len(reverse_data.get('files', []))}"
                )

                # Process files from reverse direction
                files = []
                for file in reverse_data.get("files", []):
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

                # Use reverse data if it has files
                if files:
                    compare_data = reverse_data

            return {
                "status": compare_data.get("status", ""),
                "ahead_by": compare_data.get("ahead_by", 0),
                "behind_by": compare_data.get("behind_by", 0),
                "total_commits": compare_data.get("total_commits", 0),
                "files": files,
                "diff_url": compare_data.get("diff_url", ""),
                "html_url": compare_data.get("html_url", ""),
                "permalink_url": compare_data.get("permalink_url", ""),
            }

        except requests.exceptions.RequestException as e:
            raise HTTPException(status_code=502, detail=f"GitHub API error: {str(e)}")

    def check_user_project_access(
        self,
        token: str,
        git_domain: str,
        repo_name: str,
    ) -> Dict[str, Any]:
        """
        Check if a user has access to a specific GitHub repository.

        Args:
            token: GitHub access token
            git_domain: GitHub domain (e.g., github.com or custom GHE domain)
            repo_name: Repository full name (e.g., "owner/repo")

        Returns:
            Dictionary with access information:
            - has_access: bool - Whether the user has access to the project
            - access_level: int - Access level (mapped from GitHub permission)
            - access_level_name: str - Human readable access level name
            - username: str - Username associated with the token

        Raises:
            HTTPException: When API call fails
        """
        api_base_url = self._get_api_base_url(git_domain)
        decrypt_token = self.decrypt_token(token)

        headers = {
            "Authorization": f"token {decrypt_token}",
            "Accept": "application/vnd.github.v3+json",
        }

        # First get the current user info from the token
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
            username = user_data.get("login", "")
        except requests.exceptions.RequestException as e:
            self.logger.error(f"Failed to get user info: {str(e)}")
            raise HTTPException(status_code=502, detail=f"GitHub API error: {str(e)}")

        # Check repository access by getting user's permission level
        try:
            permission_response = requests.get(
                f"{api_base_url}/repos/{repo_name}/collaborators/{username}/permission",
                headers=headers,
            )

            if permission_response.status_code == 404:
                # User is not a collaborator
                return {
                    "has_access": False,
                    "access_level": 0,
                    "access_level_name": "No Access",
                    "username": username,
                }

            permission_response.raise_for_status()
            permission_data = permission_response.json()
            permission = permission_data.get("permission", "none")

            # Map GitHub permission to access level (similar to GitLab)
            permission_mapping = {
                "admin": (50, "Admin"),
                "maintain": (40, "Maintainer"),
                "push": (30, "Developer"),
                "triage": (20, "Triage"),
                "pull": (10, "Read"),
                "none": (0, "No Access"),
            }

            access_level, access_level_name = permission_mapping.get(
                permission, (0, "Unknown")
            )

            return {
                "has_access": access_level > 0,
                "access_level": access_level,
                "access_level_name": access_level_name,
                "username": username,
            }
        except requests.exceptions.RequestException as e:
            # If we can't check permissions, assume no access
            if hasattr(e, "response") and e.response and e.response.status_code == 403:
                # 403 might mean the token doesn't have permission to check collaborators
                # Try to access the repo directly
                try:
                    repo_response = requests.get(
                        f"{api_base_url}/repos/{repo_name}",
                        headers=headers,
                    )
                    if repo_response.status_code == 200:
                        return {
                            "has_access": True,
                            "access_level": 10,
                            "access_level_name": "Read",
                            "username": username,
                        }
                except Exception:
                    pass
                return {
                    "has_access": False,
                    "access_level": 0,
                    "access_level_name": "No Access",
                    "username": username,
                }
            self.logger.error(f"Failed to check repository access: {str(e)}")
            raise HTTPException(status_code=502, detail=f"GitHub API error: {str(e)}")
