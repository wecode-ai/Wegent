# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""GitHub repository provider implementation."""

from typing import Dict, Optional, Tuple

from app.services.git_skill.models import RepoAuthInfo
from app.services.git_skill.providers.base import GitRepoProvider


class GitHubProvider(GitRepoProvider):
    """GitHub repository provider."""

    def __init__(self, host: str = "github.com", base_url: str = ""):
        self.host = host
        self.api_host = "api.github.com"
        # Use provided base_url or default to https://
        self.base_url = base_url if base_url else f"https://{host}"

    @property
    def name(self) -> str:
        return "GitHub"

    def get_api_url(self, owner: str, repo: str) -> str:
        """Get the GitHub API URL for repository info."""
        return f"https://{self.api_host}/repos/{owner}/{repo}"

    def get_api_headers(self, auth: RepoAuthInfo) -> Dict[str, str]:
        """Get API headers for GitHub authentication."""
        headers = {"Accept": "application/vnd.github.v3+json"}
        if auth and auth.password:
            headers["Authorization"] = f"Bearer {auth.password}"
        return headers

    def get_zip_auth(self, auth: RepoAuthInfo) -> Optional[Tuple[str, str]]:
        """Get authentication for ZIP download (not used for GitHub, use headers instead)."""
        return None

    def get_zip_headers(self, auth: RepoAuthInfo) -> Dict[str, str]:
        """Get headers for ZIP download authentication (GitHub uses Authorization header)."""
        headers = {}
        if auth and auth.password:
            headers["Authorization"] = f"token {auth.password}"
        return headers

    def get_zip_download_url(self, owner: str, repo: str, branch: str) -> str:
        """Get the URL to download the repository as a ZIP file."""
        return f"{self.base_url}/{owner}/{repo}/archive/refs/heads/{branch}.zip"
