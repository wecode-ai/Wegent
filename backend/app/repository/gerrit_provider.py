# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Gerrit repository provider implementation
"""
import asyncio
import base64
import hashlib
import logging
import re
from typing import Any, Dict, List, Optional

import requests
from fastapi import HTTPException
from requests.auth import HTTPBasicAuth, HTTPDigestAuth
from shared.utils.sensitive_data_masker import mask_string
from shared.utils.url_util import build_url

from app.core.cache import cache_manager
from app.core.config import settings
from app.models.user import User
from app.repository.interfaces.repository_provider import RepositoryProvider
from app.schemas.github import Branch, Repository


class GerritProvider(RepositoryProvider):
    """
    Gerrit repository provider implementation
    Support for enterprise private Gerrit instances
    """

    def __init__(self):
        self.logger = logging.getLogger(__name__)
        self.domain = "gerrit"
        self.type = "gerrit"

    def _get_git_infos(
        self, user: User, git_domain: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        """
        Collect Gerrit related entries from user's git_info (may contain multiple entries)

        Args:
            user: User object
            git_domain: Optional domain to filter a specific Gerrit entry

        Returns:
            List of dictionaries containing git_domain, git_token, username, type

        Raises:
            HTTPException: Raised when Gerrit information is not configured
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
                        "user_name": info.get("user_name", ""),
                        "type": info.get("type", ""),
                        "auth_type": info.get("auth_type", "digest"),
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
                status_code=400, detail="Gerrit information not configured"
            )
        return entries

    def _pick_git_info(self, user: User, git_domain: str) -> Dict[str, Any]:
        """
        Pick a single git_info entry based on domain or default to the first
        """
        entries = self._get_git_infos(user, git_domain)
        return entries[0]

    def _get_api_base_url(self, git_domain: str) -> str:
        """
        Get API base URL based on git domain

        Args:
            git_domain: Gerrit domain (e.g., gerrit.company.com or http://gerrit.company.com)

        Returns:
            API base URL
        """
        if not git_domain:
            raise HTTPException(status_code=400, detail="Gerrit domain is required")
        return build_url(git_domain, "/a")

    def _strip_xssi_prefix(self, response_text: str) -> str:
        """
        Strip Gerrit XSSI protection prefix from response

        Gerrit adds ")]}'" prefix to all JSON responses to prevent XSSI attacks

        Args:
            response_text: Raw response text

        Returns:
            Cleaned JSON string
        """
        if response_text.startswith(")]}'"):
            return response_text[4:]
        return response_text

    def _make_request(
        self,
        method: str,
        url: str,
        username: str,
        http_password: str,
        auth_type: str = "digest",
        params: Dict[str, Any] = None,
        json_data: Dict[str, Any] = None,
        **kwargs,
    ) -> requests.Response:
        """
        Make HTTP request with HTTP Digest or Basic Authentication

        Gerrit uses HTTP Digest Authentication by default, but some instances
        may use HTTP Basic Authentication. The /a/ prefix in the URL
        indicates authenticated access.

        Args:
            method: HTTP method (GET, POST, etc.)
            url: Request URL (should include /a/ prefix for authenticated endpoints)
            username: Gerrit username
            http_password: HTTP password from Gerrit Settings
            auth_type: Authentication type ('digest' or 'basic'), defaults to 'digest'
            params: Query parameters
            json_data: JSON payload for POST requests
            **kwargs: Additional arguments for requests

        Returns:
            Response object

        Raises:
            requests.exceptions.RequestException: If request fails
        """
        # Select authentication method based on auth_type
        if auth_type == "basic":
            auth = HTTPBasicAuth(username, http_password)
        else:
            auth = HTTPDigestAuth(username, http_password)

        headers = {"Accept": "application/json", "Content-Type": "application/json"}

        response = requests.request(
            method,
            url,
            auth=auth,
            headers=headers,
            params=params,
            json=json_data,
            **kwargs,
        )
        response.raise_for_status()
        return response

    async def _make_request_async(
        self,
        method: str,
        url: str,
        username: str,
        http_password: str,
        auth_type: str = "digest",
        params: Dict[str, Any] = None,
        json_data: Dict[str, Any] = None,
        **kwargs,
    ) -> requests.Response:
        """
        Async version of _make_request with HTTP Digest or Basic Authentication

        Args:
            method: HTTP method (GET, POST, etc.)
            url: Request URL (should include /a/ prefix for authenticated endpoints)
            username: Gerrit username
            http_password: HTTP password
            auth_type: Authentication type ('digest' or 'basic'), defaults to 'digest'
            params: Query parameters
            json_data: JSON payload
            **kwargs: Additional arguments

        Returns:
            Response object
        """
        # Select authentication method based on auth_type
        if auth_type == "basic":
            auth = HTTPBasicAuth(username, http_password)
        else:
            auth = HTTPDigestAuth(username, http_password)

        headers = {"Accept": "application/json", "Content-Type": "application/json"}

        response = await asyncio.to_thread(
            requests.request,
            method,
            url,
            auth=auth,
            headers=headers,
            params=params,
            json=json_data,
            **kwargs,
        )
        response.raise_for_status()
        return response

    async def get_repositories(
        self, user: User, page: int = 1, limit: int = 100
    ) -> List[Dict[str, Any]]:
        """
        Get user's Gerrit project list

        Args:
            user: User object
            page: Page number
            limit: Items per page

        Returns:
            Repository (project) list

        Raises:
            HTTPException: Raised when retrieval fails
        """
        # Iterate all gerrit entries for this user (may be multiple domains)
        entries = self._get_git_infos(user)
        all_repos: List[Dict[str, Any]] = []

        for entry in entries:
            git_token = entry.get("git_token") or ""
            git_domain = entry.get("git_domain") or ""
            user_name = entry.get("user_name") or ""
            auth_type = entry.get("auth_type") or "digest"

            if not git_token or not user_name:
                # Skip empty token/user_name entries
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
                            type="gerrit",
                            private=repo["private"],
                        ).model_dump()
                        for repo in paginated_repos
                    ]
                )
                continue

            try:
                # Gerrit API: List projects
                # GET /projects/?d to list all projects with descriptions
                response = self._make_request(
                    method="GET",
                    url=f"{api_base_url}/projects/",
                    username=user_name,
                    http_password=git_token,
                    auth_type=auth_type,
                    params={"d": ""},  # Include descriptions
                )

                # Parse response and strip XSSI prefix
                response_text = self._strip_xssi_prefix(response.text)
                projects = (
                    requests.models.complexjson.loads(response_text)
                    if response_text
                    else {}
                )

                # Convert Gerrit projects to standard format
                repos = []
                for project_name, project_info in projects.items():
                    # Generate a numeric ID based on project name hash
                    project_id = abs(hash(project_name)) % (10**10)

                    # Build clone URL
                    clone_url = build_url(git_domain, f"/{project_name}.git")

                    repos.append(
                        {
                            "id": project_id,
                            "name": project_name.split("/")[
                                -1
                            ],  # Get last part as name
                            "full_name": project_name,
                            "clone_url": clone_url,
                            "git_domain": git_domain,
                            "type": "gerrit",
                            "private": True,  # Gerrit doesn't expose public/private flag, assume private
                        }
                    )

                # Sort by project name
                repos.sort(key=lambda x: x["full_name"])

                # Cache if all projects are retrieved (Gerrit returns all in one call)
                cache_key = cache_manager.generate_full_cache_key(user.id, git_domain)
                await cache_manager.set(
                    cache_key, repos, expire=settings.REPO_CACHE_EXPIRED_TIME
                )

                # Apply pagination
                start_idx = (page - 1) * limit
                end_idx = start_idx + limit
                paginated_repos = repos[start_idx:end_idx]

                all_repos.extend(
                    [
                        Repository(
                            id=repo["id"],
                            name=repo["name"],
                            full_name=repo["full_name"],
                            clone_url=repo["clone_url"],
                            git_domain=git_domain,
                            type="gerrit",
                            private=repo["private"],
                        ).model_dump()
                        for repo in paginated_repos
                    ]
                )

            except requests.exceptions.RequestException as e:
                self.logger.error(
                    f"Failed to fetch Gerrit projects from {git_domain}: {str(e)}"
                )
                # Skip failed domain, continue others
                continue

        return all_repos

    async def get_branches(
        self, user: User, repo_name: str, git_domain: str
    ) -> List[Dict[str, Any]]:
        """
        Get branch list for specified Gerrit project

        Args:
            user: User object
            repo_name: Project name (e.g., "project" or "path/to/project")
            git_domain: Git domain

        Returns:
            Branch list

        Raises:
            HTTPException: Raised when retrieval fails
        """
        git_info = self._pick_git_info(user, git_domain)
        git_token = git_info["git_token"]
        user_name = git_info["user_name"]
        auth_type = git_info.get("auth_type") or "digest"

        if not git_token or not user_name:
            raise HTTPException(
                status_code=400, detail="Gerrit credentials not configured"
            )

        # Get API base URL based on git domain
        api_base_url = self._get_api_base_url(git_domain)

        try:
            # URL encode project name (replace / with %2F)
            encoded_project = requests.utils.quote(repo_name, safe="")

            # Get branches from Gerrit API
            # GET /projects/{project-name}/branches/
            response = self._make_request(
                method="GET",
                url=f"{api_base_url}/projects/{encoded_project}/branches/",
                username=user_name,
                http_password=git_token,
                auth_type=auth_type,
            )

            # Parse response and strip XSSI prefix
            response_text = self._strip_xssi_prefix(response.text)
            branches_data = (
                requests.models.complexjson.loads(response_text)
                if response_text
                else []
            )

            # Get default branch (HEAD ref)
            default_branch_name = self._get_default_branch(
                repo_name, git_domain, user_name, git_token, auth_type
            )

            branches = []
            for branch in branches_data:
                branch_name = branch.get("ref", "").replace("refs/heads/", "")
                if branch_name:  # Skip empty names
                    branches.append(
                        Branch(
                            name=branch_name,
                            protected=False,  # Gerrit doesn't expose protected flag in branch list
                            default=branch_name == default_branch_name,
                        ).model_dump()
                    )

            return branches

        except requests.exceptions.RequestException as e:
            self.logger.error(f"Failed to get branches for {repo_name}: {str(e)}")
            raise HTTPException(status_code=502, detail=f"Gerrit API error: {str(e)}")

    def _get_default_branch(
        self,
        repo_name: str,
        git_domain: str,
        user_name: str,
        git_token: str,
        auth_type: str = "digest",
    ) -> str:
        """
        Get default branch for a Gerrit project

        Args:
            repo_name: Project name
            git_domain: Git domain
            user_name: Gerrit user_name
            git_token: HTTP password
            auth_type: Authentication type ('digest' or 'basic')

        Returns:
            Default branch name (e.g., "master" or "main")
        """
        api_base_url = self._get_api_base_url(git_domain)
        encoded_project = requests.utils.quote(repo_name, safe="")

        try:
            # Get HEAD reference
            response = self._make_request(
                method="GET",
                url=f"{api_base_url}/projects/{encoded_project}/HEAD",
                username=user_name,
                http_password=git_token,
                auth_type=auth_type,
            )

            # Parse response and strip XSSI prefix
            response_text = self._strip_xssi_prefix(response.text)
            head_ref = response_text.strip().strip('"')

            # Extract branch name from ref (e.g., "refs/heads/master" -> "master")
            if head_ref.startswith("refs/heads/"):
                return head_ref.replace("refs/heads/", "")

            return "master"  # Fallback

        except Exception as e:
            self.logger.warning(
                f"Failed to get default branch for {repo_name}: {str(e)}"
            )
            return "master"  # Fallback to master

    def validate_token(
        self,
        token: str,
        git_domain: str = None,
        user_name: str = None,
        auth_type: str = "digest",
    ) -> Dict[str, Any]:
        """
        Validate Gerrit HTTP password

        Args:
            token: HTTP password from Gerrit Settings
            git_domain: Gerrit domain
            user_name: Gerrit user_name
            auth_type: Authentication type ('digest' or 'basic'), defaults to 'digest'

        Returns:
            Validation result including validity, user information, etc.

        Raises:
            HTTPException: Raised when validation fails
        """
        if not token or not git_domain or not user_name:
            raise HTTPException(
                status_code=400,
                detail="Gerrit credentials (token, domain, user_name) are required",
            )

        api_base_url = self._get_api_base_url(git_domain)
        decrypt_token = self.decrypt_token(token)

        try:
            # Validate by getting account info
            # GET /accounts/self
            response = self._make_request(
                method="GET",
                url=f"{api_base_url}/accounts/self",
                username=user_name,
                http_password=decrypt_token,
                auth_type=auth_type,
            )

            # Parse response and strip XSSI prefix
            response_text = self._strip_xssi_prefix(response.text)
            user_data = (
                requests.models.complexjson.loads(response_text)
                if response_text
                else {}
            )

            return {
                "valid": True,
                "user": {
                    "id": user_data.get("_account_id", 0),
                    "login": user_data.get("user_name", user_name),
                    "name": user_data.get("name", ""),
                    "avatar_url": "",  # Gerrit doesn't provide avatar URL in account API
                    "email": user_data.get("email", ""),
                },
            }

        except requests.exceptions.RequestException as e:
            self.logger.error(f"Gerrit API request failed: {str(e)}")
            if hasattr(e, "response") and e.response and e.response.status_code == 401:
                self.logger.warning(
                    f"Gerrit token validation failed: 401 Unauthorized, git_domain: {git_domain}, user_name: {user_name}, auth_type: {auth_type}"
                )
                return {
                    "valid": False,
                    "error": "auth_failed",
                    "message": f"Authentication failed. Please check if the auth method ({auth_type}) is correct.",
                }
            raise HTTPException(status_code=502, detail=f"Gerrit API error: {str(e)}")
        except Exception as e:
            self.logger.error(f"Unexpected error during token validation: {str(e)}")
            raise HTTPException(
                status_code=500, detail=f"Token validation failed: {str(e)}"
            )

    async def search_repositories(
        self, user: User, query: str, timeout: int = 30, fullmatch: bool = False
    ) -> List[Dict[str, Any]]:
        """
        Search user's Gerrit projects across all configured Gerrit domains

        Args:
            user: User object
            query: Search keyword
            timeout: Timeout in seconds
            fullmatch: Enable exact match (true) or partial match (false)

        Returns:
            Aggregated search results from all configured Gerrit domains

        Raises:
            HTTPException: Raised when search fails
        """
        # Normalize query, case-insensitive
        query_lower = query.lower()

        # Iterate all gerrit entries for this user (may be multiple domains)
        entries = self._get_git_infos(user)
        all_results: List[Dict[str, Any]] = []

        for entry in entries:
            git_token = entry.get("git_token") or ""
            git_domain = entry.get("git_domain") or ""
            user_name = entry.get("user_name") or ""
            auth_type = entry.get("auth_type") or "digest"

            if not git_token or not user_name:
                # Skip empty token/user_name entries
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
                            type="gerrit",
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

                # Try cache again
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
                                type="gerrit",
                                private=repo["private"],
                            ).model_dump()
                            for repo in filtered_repos
                        ]
                    )
                    continue

            # 3) No cache and not building, trigger domain-level full retrieval
            await self._fetch_all_repositories_async(
                user, git_token, user_name, git_domain, auth_type
            )

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
                            type="gerrit",
                            private=repo["private"],
                        ).model_dump()
                        for repo in filtered_repos
                    ]
                )

        return all_results

    async def _fetch_all_repositories_async(
        self,
        user: User,
        git_token: str,
        user_name: str,
        git_domain: str,
        auth_type: str = "digest",
    ) -> None:
        """
        Asynchronously fetch all user's Gerrit projects and cache them

        Args:
            user: User object
            git_token: HTTP password
            user_name: Gerrit user_name
            git_domain: Git domain
            auth_type: Authentication type ('digest' or 'basic')
        """
        # Check if already building
        if await cache_manager.is_building(user.id, git_domain):
            return

        await cache_manager.set_building(user.id, git_domain, True)

        try:
            # Get API base URL based on git domain
            api_base_url = self._get_api_base_url(git_domain)

            self.logger.info(f"Fetching gerrit all projects for user {user.user_name}")

            # Gerrit returns all projects in one call
            response = await self._make_request_async(
                method="GET",
                url=f"{api_base_url}/projects/",
                username=user_name,
                http_password=git_token,
                auth_type=auth_type,
                params={"d": ""},  # Include descriptions
            )

            # Parse response and strip XSSI prefix
            response_text = self._strip_xssi_prefix(response.text)
            projects = (
                requests.models.complexjson.loads(response_text)
                if response_text
                else {}
            )

            # Convert to standard format
            all_repos = []
            for project_name, project_info in projects.items():
                project_id = abs(hash(project_name)) % (10**10)
                clone_url = build_url(git_domain, f"/{project_name}.git")

                all_repos.append(
                    {
                        "id": project_id,
                        "name": project_name.split("/")[-1],
                        "full_name": project_name,
                        "clone_url": clone_url,
                        "git_domain": git_domain,
                        "type": "gerrit",
                        "private": True,
                    }
                )

            # Sort by project name
            all_repos.sort(key=lambda x: x["full_name"])

            # Cache complete repository list
            cache_key = cache_manager.generate_full_cache_key(user.id, git_domain)
            await cache_manager.set(
                cache_key, all_repos, expire=settings.REPO_CACHE_EXPIRED_TIME
            )
            self.logger.info(
                f"Cache complete repository list for user gerrit {user.user_name}"
            )

        except Exception as e:
            # Background task fails silently
            self.logger.error(
                f"Failed to fetch gerrit projects for user {user.user_name}: {str(e)}"
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
        Get diff between two branches for a Gerrit project

        Args:
            user: User object
            repo_name: Project name
            source_branch: Source branch name (the branch with changes)
            target_branch: Target branch name (the branch to compare against)
            git_domain: Git domain

        Returns:
            Diff information including files changed and diff content

        Note:
            Gerrit doesn't have a direct compare API like GitHub/GitLab.
            This implementation uses commit list to find differences.
        """
        git_info = self._pick_git_info(user, git_domain)
        git_token = git_info["git_token"]
        user_name = git_info["user_name"]

        if not git_token or not user_name:
            raise HTTPException(
                status_code=400, detail="Gerrit credentials not configured"
            )

        # Get API base URL based on git domain
        api_base_url = self._get_api_base_url(git_domain)

        try:
            # URL encode project name
            encoded_project = requests.utils.quote(repo_name, safe="")

            # Get commits in source branch that are not in target branch
            # This is a simplified implementation
            # In a real scenario, you might need to use git commands or more complex logic

            # For now, return a basic structure indicating branches are different
            # In production, you might want to implement actual diff logic using git commands
            # or leverage Gerrit's changes API

            return {
                "status": "different",
                "ahead_by": 0,
                "behind_by": 0,
                "total_commits": 0,
                "files": [],
                "diff_url": "",
                "html_url": build_url(
                    git_domain, f"/q/project:{repo_name}+branch:{source_branch}"
                ),
                "permalink_url": build_url(
                    git_domain, f"/q/project:{repo_name}+branch:{source_branch}"
                ),
                "message": "Gerrit branch comparison is not fully supported. Please use Gerrit web interface for detailed diff.",
            }

        except requests.exceptions.RequestException as e:
            raise HTTPException(status_code=502, detail=f"Gerrit API error: {str(e)}")

    def generate_change_id(
        self, commit_message: str, project_name: str, branch: str
    ) -> str:
        """
        Generate Change-Id for Gerrit commit

        Gerrit requires a Change-Id footer in commit messages.
        Format: I<40 character SHA-1>

        Args:
            commit_message: Commit message content
            project_name: Project name
            branch: Branch name

        Returns:
            Change-Id string (e.g., "I1234567890abcdef...")
        """
        # Generate SHA-1 hash based on message, project, and branch
        # This is a simplified implementation
        data = f"{commit_message}{project_name}{branch}".encode("utf-8")
        sha1_hash = hashlib.sha1(data).hexdigest()
        return f"I{sha1_hash}"

    async def create_change(
        self,
        user: User,
        repo_name: str,
        branch: str,
        subject: str,
        git_domain: str,
        topic: str = None,
    ) -> Dict[str, Any]:
        """
        Create a new Change in Gerrit (equivalent to Pull Request)

        The created Change will be in DRAFT status by default.

        Args:
            user: User object
            repo_name: Project name
            branch: Target branch
            subject: Change subject (title)
            git_domain: Git domain
            topic: Optional topic name

        Returns:
            Created Change information

        Raises:
            HTTPException: Raised when creation fails
        """
        git_info = self._pick_git_info(user, git_domain)
        git_token = git_info["git_token"]
        user_name = git_info["user_name"]
        auth_type = git_info.get("auth_type") or "digest"

        if not git_token or not user_name:
            raise HTTPException(
                status_code=400, detail="Gerrit credentials not configured"
            )

        # Get API base URL based on git domain
        api_base_url = self._get_api_base_url(git_domain)

        try:
            # Create change via Gerrit REST API
            # POST /changes/
            change_input = {
                "project": repo_name,
                "branch": branch,
                "subject": subject,
                "status": "DRAFT",  # Create as draft
            }

            if topic:
                change_input["topic"] = topic

            response = self._make_request(
                method="POST",
                url=f"{api_base_url}/changes/",
                username=user_name,
                http_password=git_token,
                auth_type=auth_type,
                json_data=change_input,
            )

            # Parse response and strip XSSI prefix
            response_text = self._strip_xssi_prefix(response.text)
            change_data = (
                requests.models.complexjson.loads(response_text)
                if response_text
                else {}
            )

            return {
                "id": change_data.get("id", ""),
                "change_id": change_data.get("change_id", ""),
                "number": change_data.get("_number", 0),
                "subject": change_data.get("subject", ""),
                "status": change_data.get("status", ""),
                "created": change_data.get("created", ""),
                "updated": change_data.get("updated", ""),
                "url": build_url(git_domain, f"/c/{change_data.get('_number', 0)}"),
            }

        except requests.exceptions.RequestException as e:
            raise HTTPException(status_code=502, detail=f"Gerrit API error: {str(e)}")
