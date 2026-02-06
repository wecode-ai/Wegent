# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Gitea repository provider implementation."""

from typing import Dict

from app.services.git_skill.models import RepoAuthInfo
from app.services.git_skill.providers.base import (
    GitRepoProvider,
    TokenBasicAuthMixin,
)


class GiteaProvider(TokenBasicAuthMixin, GitRepoProvider):
    """Gitea repository provider (self-hosted)."""

    def __init__(self, host: str, base_url: str = ""):
        self.host = host
        # Use provided base_url or default to https://
        self.base_url = base_url if base_url else f"https://{host}"

    @property
    def name(self) -> str:
        return "Gitea"

    def get_api_url(self, owner: str, repo: str) -> str:
        """Get the Gitea API URL for repository info."""
        return f"{self.base_url}/api/v1/repos/{owner}/{repo}"

    def get_api_headers(self, auth: RepoAuthInfo) -> Dict[str, str]:
        """Get API headers for Gitea authentication."""
        headers = {}
        if auth and auth.password:
            headers["Authorization"] = f"token {auth.password}"
        return headers

    def get_zip_download_url(self, owner: str, repo: str, branch: str) -> str:
        """Get the URL to download the repository as a ZIP file."""
        return f"{self.base_url}/{owner}/{repo}/archive/{branch}.zip"
