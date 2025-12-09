# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
GitLab repository provider implementation
"""
import asyncio
import logging
from typing import Any, Dict, List, Optional

import requests
from fastapi import HTTPException
from shared.utils.url_util import build_url

from app.core.cache import cache_manager
from app.core.config import settings
from app.models.user import User
from app.repository.interfaces.repository_provider import RepositoryProvider
from app.schemas.github import Branch, Repository


class GitLabProvider(RepositoryProvider):
    """
    GitLab repository provider implementation
    """

    def __init__(self):
        self.logger = logging.getLogger(__name__)
        self.api_base_url = "https://gitlab.com/api/v4"
        self.domain = "gitlab.com"
        self.type = "gitlab"

    def _get_git_infos(
        self, user: User, git_domain: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        """
        Collect GitLab related entries from user's git_info (may contain multiple entries)

        Args:
            user: User object
            git_domain: Optional domain to filter a specific GitLab entry

        Returns:
            List of dictionaries containing git_domain, git_token, type

        Raises:
            HTTPException: Raised when GitLab information is not configured
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

        if git_domain == "gitlab.com":
            return "https://gitlab.com/api/v4"
        else:
            # Custom GitLab domain (may include http:// protocol)
            return build_url(git_domain, "/api/v4")

    def _make_request_with_auth_retry(
        self, method: str, url: str, token: str, params: Dict[str, Any] = None, **kwargs
    ) -> requests.Response:
        """
        Make HTTP request with authentication retry logic.
        First tries Bearer token, if 401 then retries with Private-Token.

        Args:
            method: HTTP method (GET, POST, etc.)
            url: Request URL
            token: GitLab token
            params: Query parameters
            **kwargs: Additional arguments for requests

        Returns:
            Response object

        Raises:
            requests.exceptions.RequestException: If both authentication methods fail
        """
        # Try Bearer token first (for OAuth tokens)
        headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}

        try:
            response = requests.request(
                method, url, headers=headers, params=params, **kwargs
            )
            if response.status_code != 401:
                response.raise_for_status()
                return response
        except requests.exceptions.RequestException as e:
            if not (
                hasattr(e, "response") and e.response and e.response.status_code == 401
            ):
                raise

        # If 401, retry with Private-Token (for Personal Access Tokens)
        self.logger.info(f"Bearer auth failed with 401, retrying with Private-Token")
        headers = {"Private-Token": token, "Accept": "application/json"}

        response = requests.request(
            method, url, headers=headers, params=params, **kwargs
        )
        response.raise_for_status()
        return response

    async def _make_request_with_auth_retry_async(
        self, method: str, url: str, token: str, params: Dict[str, Any] = None, **kwargs
    ) -> requests.Response:
        """
        Async version of _make_request_with_auth_retry.
        Make HTTP request with authentication retry logic in async context.

        Args:
            method: HTTP method (GET, POST, etc.)
            url: Request URL
            token: GitLab token
            params: Query parameters
            **kwargs: Additional arguments for requests

        Returns:
            Response object

        Raises:
            requests.exceptions.RequestException: If both authentication methods fail
        """
        # Try Bearer token first (for OAuth tokens)
        headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}

        try:
            response = await asyncio.to_thread(
                requests.request, method, url, headers=headers, params=params, **kwargs
            )
            if response.status_code != 401:
                response.raise_for_status()
                return response
        except requests.exceptions.RequestException as e:
            if not (
                hasattr(e, "response") and e.response and e.response.status_code == 401
            ):
                raise

        # If 401, retry with Private-Token (for Personal Access Tokens)
        self.logger.info(f"Bearer auth failed with 401, retrying with Private-Token")
        headers = {"Private-Token": token, "Accept": "application/json"}

        response = await asyncio.to_thread(
            requests.request, method, url, headers=headers, params=params, **kwargs
        )
        response.raise_for_status()
        return response

    async def get_repositories(
        self, user: User, page: int = 1, limit: int = 100
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
        # iterate all gitlab entries for this user (may be multiple domains)
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
                            type="gitlab",
                            private=repo["private"],
                        ).model_dump()
                        for repo in paginated_repos
                    ]
                )
                continue

            try:
                response = self._make_request_with_auth_retry(
                    method="GET",
                    url=f"{api_base_url}/projects",
                    token=git_token,
                    params={
                        "per_page": limit,
                        "page": page,
                        "order_by": "last_activity_at",
                        "membership": "true",
                    },
                )

                repos = response.json()

                all_repos.extend(
                    [
                        Repository(
                            id=repo["id"],
                            name=repo["name"],
                            full_name=repo["path_with_namespace"],
                            clone_url=repo["http_url_to_repo"],
                            git_domain=git_domain,
                            type="gitlab",
                            private=repo["visibility"] == "private",
                        ).model_dump()
                        for repo in repos
                    ]
                )

                # domain-level caching
                if len(all_repos) < limit:
                    cache_key = cache_manager.generate_full_cache_key(
                        user.id, git_domain
                    )
                    await cache_manager.set(
                        cache_key, all_repos, expire=settings.REPO_CACHE_EXPIRED_TIME
                    )
                else:
                    asyncio.create_task(
                        self._fetch_all_repositories_async(user, git_token, git_domain)
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
            # First, get the project ID from the repo name
            encoded_repo_name = repo_name.replace("/", "%2F")

            all_branches = []
            page = 1
            per_page = 100

            while True:
                response = self._make_request_with_auth_retry(
                    method="GET",
                    url=f"{api_base_url}/projects/{encoded_repo_name}/repository/branches",
                    token=git_token,
                    params={"per_page": per_page, "page": page},
                )

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
                    default=branch.get("default", False),
                ).model_dump()
                for branch in all_branches
            ]
        except requests.exceptions.RequestException as e:
            # If 404 Not Found, return empty list to simplify result
            try:
                if (
                    getattr(e, "response", None) is not None
                    and e.response is not None
                    and e.response.status_code == 404
                ):
                    return []
            except Exception:
                pass
            raise HTTPException(status_code=502, detail=f"GitLab API error: {str(e)}")

    def validate_token(self, token: str, git_domain: str = None) -> Dict[str, Any]:
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
            raise HTTPException(status_code=400, detail="Git token is required")

        # Use custom domain if provided, otherwise use default
        api_base_url = self._get_api_base_url(git_domain)

        decrypt_token = self.decrypt_token(token)

        try:
            response = self._make_request_with_auth_retry(
                method="GET", url=f"{api_base_url}/user", token=decrypt_token
            )

            user_data = response.json()

            return {
                "valid": True,
                "user": {
                    "id": user_data["id"],
                    "login": user_data["username"],
                    "name": user_data.get("name"),
                    "avatar_url": user_data.get("avatar_url"),
                    "email": user_data.get("email"),
                },
            }

        except requests.exceptions.RequestException as e:
            self.logger.error(f"GitLab API request failed: {str(e)}")
            # If both auth methods failed with 401, token is invalid
            if hasattr(e, "response") and e.response and e.response.status_code == 401:
                self.logger.warning(
                    f"GitLab token validation failed: 401 Unauthorized, git_domain: {git_domain}"
                )
                return {
                    "valid": False,
                }
            raise HTTPException(status_code=502, detail=f"GitLab API error: {str(e)}")
        except Exception as e:
            self.logger.error(f"Unexpected error during token validation: {str(e)}")
            raise HTTPException(
                status_code=500, detail=f"Token validation failed: {str(e)}"
            )

    async def search_repositories(
        self, user: User, query: str, timeout: int = 30, fullmatch: bool = False
    ) -> List[Dict[str, Any]]:
        """
        Search user's GitLab repositories across all configured GitLab domains

        Args:
            user: User object
            query: Search keyword
            timeout: Timeout in seconds
            fullmatch: Enable exact match (true) or partial match (false)

        Returns:
            Aggregated search results from all configured GitLab domains

        Raises:
            HTTPException: Raised when search fails
        """
        # Normalize query, case-insensitive
        query_lower = query.lower()

        # Iterate all gitlab entries for this user (may be multiple domains)
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
                            type="gitlab",
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
                                type="gitlab",
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
                            type="gitlab",
                            private=repo["private"],
                        ).model_dump()
                        for repo in filtered_repos
                    ]
                )
                continue

            # 5) Fallback: fetch first page for this domain only (avoid cross-domain aggregation)
            try:
                api_base_url = self._get_api_base_url(git_domain)
                response = self._make_request_with_auth_retry(
                    method="GET",
                    url=f"{api_base_url}/projects",
                    token=git_token,
                    params={
                        "per_page": 100,
                        "page": 1,
                        "order_by": "last_activity_at",
                        "membership": "true",
                    },
                )
                repos = response.json()
                mapped = [
                    {
                        "id": repo["id"],
                        "name": repo["name"],
                        "full_name": repo["path_with_namespace"],
                        "clone_url": repo["http_url_to_repo"],
                        "git_domain": git_domain,
                        "type": "gitlab",
                        "private": repo["visibility"] == "private",
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
                            type="gitlab",
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
        self, user: User, git_token: str = None, git_domain: str = None
    ) -> None:
        """
        Asynchronously fetch all user's GitLab repositories and cache them

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

            all_repos = []
            page = 1
            per_page = 100

            self.logger.info(
                f"Fetching gitlab all repositories for user {user.user_name}"
            )

            while True:
                response = await self._make_request_with_auth_retry_async(
                    method="GET",
                    url=f"{api_base_url}/projects",
                    token=git_token,
                    params={
                        "per_page": per_page,
                        "page": page,
                        "order_by": "last_activity_at",
                        "membership": "true",
                    },
                )

                repos = response.json()
                if not repos:
                    break

                # Map GitLab API response to standard format
                mapped_repos = [
                    {
                        "id": repo["id"],
                        "name": repo["name"],
                        "full_name": repo["path_with_namespace"],
                        "clone_url": repo["http_url_to_repo"],
                        "git_domain": git_domain,
                        "type": "gitlab",
                        "private": repo["visibility"] == "private",
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
                f"Cache complete repository list for user gitlab {user.user_name}"
            )

        except Exception as e:
            # Background task fails silently
            self.logger.error(
                f"Failed to fetch gitlab repositories for user {user.user_name}: {str(e)}"
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
        Get diff between two branches for a GitLab repository

        Args:
            user: User object
            repo_name: Repository name
            source_branch: Source branch name
            target_branch: Target branch name
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
            # Get repository ID first (GitLab API uses project ID)
            encoded_repo_name = requests.utils.quote(repo_name, safe="")
            repo_response = self._make_request_with_auth_retry(
                method="GET",
                url=f"{api_base_url}/projects/{encoded_repo_name}",
                token=git_token,
            )
            repo_data = repo_response.json()
            project_id = repo_data["id"]

            # Get compare API response
            response = self._make_request_with_auth_retry(
                method="GET",
                url=f"{api_base_url}/projects/{project_id}/repository/compare",
                token=git_token,
                params={"from": target_branch, "to": source_branch},
            )

            compare_data = response.json()
            self.logger.info(f"Response: {compare_data}")

            # Process commits
            commits = []
            for commit in compare_data.get("commits", []):
                commit_info = {
                    "id": commit.get("id", ""),
                    "short_id": commit.get("short_id", ""),
                    "title": commit.get("title", ""),
                    "message": commit.get("message", ""),
                    "author_name": commit.get("author_name", ""),
                    "author_email": commit.get("author_email", ""),
                    "created_at": commit.get("created_at", ""),
                }
                commits.append(commit_info)

            # Process diffs and files - convert to GitHub-compatible format
            files = []
            for diff in compare_data.get("diffs", []):
                # Determine status based on GitLab diff flags
                status = "modified"
                if diff.get("new_file", False):
                    status = "added"
                elif diff.get("deleted_file", False):
                    status = "removed"
                elif diff.get("renamed_file", False):
                    status = "renamed"

                # Parse diff to count additions and deletions (simplified)
                diff_content = diff.get("diff", "")
                additions = diff_content.count("\n+") if diff_content else 0
                deletions = diff_content.count("\n-") if diff_content else 0

                file_info = {
                    "filename": diff.get("new_path", ""),
                    "status": status,
                    "additions": additions,
                    "deletions": deletions,
                    "changes": additions + deletions,
                    "patch": diff_content,
                    "previous_filename": (
                        diff.get("old_path", "")
                        if diff.get("renamed_file", False)
                        else ""
                    ),
                    "blob_url": "",  # GitLab doesn't provide this in compare API
                    "raw_url": "",  # GitLab doesn't provide this in compare API
                    "contents_url": "",  # GitLab doesn't provide this in compare API
                }
                files.append(file_info)

            return {
                "status": "ahead" if len(commits) > 0 else "identical",
                "ahead_by": len(commits),
                "behind_by": 0,  # GitLab compare API doesn't provide this information
                "total_commits": len(commits),
                "files": files,
                "diff_url": "",  # GitLab doesn't provide this in compare API
                "html_url": compare_data.get("web_url", ""),
                "permalink_url": compare_data.get("web_url", ""),
            }

        except requests.exceptions.RequestException as e:
            raise HTTPException(status_code=502, detail=f"GitLab API error: {str(e)}")

    def check_user_project_access(
        self,
        token: str,
        git_domain: str,
        project_id: str,
    ) -> Dict[str, Any]:
        """
        Check if a user has access to a specific GitLab project.

        Args:
            token: GitLab access token
            git_domain: GitLab domain (e.g., gitlab.com or custom domain)
            project_id: Project ID or URL-encoded path (e.g., "namespace/project")

        Returns:
            Dictionary with access information:
            - has_access: bool - Whether the user has access to the project
            - access_level: int - Access level (0=No access, 10=Guest, 20=Reporter, 30=Developer, 40=Maintainer, 50=Owner)
            - access_level_name: str - Human readable access level name
            - username: str - Username associated with the token

        Raises:
            HTTPException: When API call fails
        """
        api_base_url = self._get_api_base_url(git_domain)
        decrypt_token = self.decrypt_token(token)

        # First get the current user info from the token
        try:
            user_response = self._make_request_with_auth_retry(
                method="GET",
                url=f"{api_base_url}/user",
                token=decrypt_token,
            )
            user_data = user_response.json()
            user_id = user_data.get("id")
            username = user_data.get("username", "")
        except requests.exceptions.RequestException as e:
            self.logger.error(f"Failed to get user info: {str(e)}")
            if hasattr(e, "response") and e.response and e.response.status_code == 401:
                return {
                    "has_access": False,
                    "access_level": 0,
                    "access_level_name": "No Access",
                    "username": "",
                    "error": "Invalid token",
                }
            raise HTTPException(status_code=502, detail=f"GitLab API error: {str(e)}")

        # Check project member access
        encoded_project_id = (
            project_id.replace("/", "%2F") if "/" in project_id else project_id
        )
        try:
            # Try to get the project member info for this user
            member_response = self._make_request_with_auth_retry(
                method="GET",
                url=f"{api_base_url}/projects/{encoded_project_id}/members/all/{user_id}",
                token=decrypt_token,
            )
            member_data = member_response.json()
            access_level = member_data.get("access_level", 0)

            access_level_names = {
                10: "Guest",
                20: "Reporter",
                30: "Developer",
                40: "Maintainer",
                50: "Owner",
            }

            return {
                "has_access": True,
                "access_level": access_level,
                "access_level_name": access_level_names.get(access_level, "Unknown"),
                "username": username,
            }
        except requests.exceptions.RequestException as e:
            # 404 means user is not a member of the project
            if hasattr(e, "response") and e.response and e.response.status_code == 404:
                return {
                    "has_access": False,
                    "access_level": 0,
                    "access_level_name": "No Access",
                    "username": username,
                }
            self.logger.error(f"Failed to check project access: {str(e)}")
            raise HTTPException(status_code=502, detail=f"GitLab API error: {str(e)}")
