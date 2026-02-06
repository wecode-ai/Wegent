# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Base class for Git repository providers.

This module provides the abstract base class and common functionality
for all Git repository providers (GitHub, GitLab, Gitee, Gitea).
"""

import logging
from abc import ABC, abstractmethod
from typing import Dict, Optional, Tuple

import httpx
from fastapi import HTTPException

from app.services.git_skill.models import RepoAuthInfo

logger = logging.getLogger(__name__)


class GitRepoProvider(ABC):
    """Abstract base class for Git repository providers."""

    # Base URL with protocol and port (e.g., "http://localhost:6000" or "https://github.com")
    base_url: str = ""
    host: str = ""

    @property
    @abstractmethod
    def name(self) -> str:
        """Provider name for display."""
        pass

    @abstractmethod
    def get_api_url(self, owner: str, repo: str) -> str:
        """Get the API URL for repository info."""
        pass

    @abstractmethod
    def get_api_headers(self, auth: RepoAuthInfo) -> Dict[str, str]:
        """Get API headers for authentication."""
        pass

    @abstractmethod
    def get_zip_download_url(self, owner: str, repo: str, branch: str) -> str:
        """Get the URL to download the repository as a ZIP file."""
        pass

    @abstractmethod
    def get_zip_auth(self, auth: RepoAuthInfo) -> Optional[Tuple[str, str]]:
        """Get authentication tuple for ZIP download (username, password)."""
        pass

    def get_zip_headers(self, auth: RepoAuthInfo) -> Dict[str, str]:
        """Get headers for ZIP download authentication (optional, default empty)."""
        return {}

    def get_default_branch_key(self) -> str:
        """Get the JSON key for default branch in API response."""
        return "default_branch"

    def get_default_branch_fallback(self) -> str:
        """Get the fallback default branch name."""
        return "main"

    def get_default_branch(
        self, owner: str, repo: str, auth: Optional[RepoAuthInfo] = None
    ) -> str:
        """
        Get the default branch name for a repository.

        This is a template method that handles common HTTP request logic.
        Subclasses can override specific parts via hook methods.
        """
        url = self.get_api_url(owner, repo)
        headers = self.get_api_headers(auth) if auth else {}

        # Log request details
        self._log_api_request(url, auth, headers)

        try:
            with httpx.Client(timeout=30.0) as client:
                response = client.get(url, headers=headers if headers else None)

                self._log_api_response(url, response.status_code)

                self._handle_api_errors(response)

                data = response.json()
                return data.get(
                    self.get_default_branch_key(), self.get_default_branch_fallback()
                )
        except httpx.RequestError as e:
            logger.error(f"{self.name} API request failed: {str(e)}, url={url}")
            raise HTTPException(
                status_code=503,
                detail=f"Failed to connect to {self.name} API: {str(e)}",
            )

    def _log_api_request(
        self, url: str, auth: Optional[RepoAuthInfo], headers: Dict[str, str]
    ) -> None:
        """Log API request details including authentication info."""
        auth_source = auth.auth_source if auth else "none"
        has_token = bool(auth and auth.password)
        token_preview = (
            f"{auth.password[:8]}..."
            if has_token and len(auth.password) > 8
            else ("***" if has_token else "none")
        )
        logger.info(
            f"{self.name} API request: GET {url}, "
            f"auth_source={auth_source}, "
            f"has_token={has_token}, "
            f"token_preview={token_preview}, "
            f"headers={list(headers.keys())}"
        )

    def _log_api_response(self, url: str, status_code: int) -> None:
        """Log API response details."""
        logger.info(f"{self.name} API response: status_code={status_code}, url={url}")

    def _handle_api_errors(self, response: httpx.Response) -> None:
        """Handle common API error responses."""
        if response.status_code == 404:
            raise HTTPException(
                status_code=404,
                detail="Repository not found or not accessible",
            )
        if response.status_code in (401, 403):
            raise HTTPException(
                status_code=403,
                detail="Authentication failed. Please check your access token.",
            )
        if response.status_code != 200:
            raise HTTPException(
                status_code=response.status_code,
                detail=f"Failed to get repository info: {response.text}",
            )


class TokenBasicAuthMixin:
    """
    Mixin for providers that use basic auth with token for ZIP download.

    Used by Gitee and Gitea providers.
    """

    def get_zip_auth(self, auth: RepoAuthInfo) -> Optional[Tuple[str, str]]:
        """Get authentication for ZIP download using basic auth."""
        if auth and auth.username and auth.password:
            return (auth.username, auth.password)
        if auth and auth.password:
            # Use token as password with empty username
            return ("", auth.password)
        return None
