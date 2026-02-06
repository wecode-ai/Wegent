# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Gitee repository provider implementation."""

from typing import Dict, Optional, Tuple

from app.services.git_skill.models import RepoAuthInfo
from app.services.git_skill.providers.base import (
    GitRepoProvider,
    TokenBasicAuthMixin,
)


class GiteeProvider(TokenBasicAuthMixin, GitRepoProvider):
    """Gitee repository provider."""

    def __init__(self, host: str = "gitee.com", base_url: str = ""):
        self.host = host
        # Use provided base_url or default to https://
        self.base_url = base_url if base_url else f"https://{host}"

    @property
    def name(self) -> str:
        return "Gitee"

    def get_api_url(self, owner: str, repo: str) -> str:
        """Get the Gitee API URL for repository info."""
        return f"{self.base_url}/api/v5/repos/{owner}/{repo}"

    def get_api_headers(self, auth: RepoAuthInfo) -> Dict[str, str]:
        """Get API headers for Gitee authentication."""
        headers = {}
        if auth and auth.password:
            headers["Authorization"] = f"Bearer {auth.password}"
        return headers

    def get_zip_download_url(self, owner: str, repo: str, branch: str) -> str:
        """Get the URL to download the repository as a ZIP file."""
        return f"{self.base_url}/{owner}/{repo}/repository/archive/{branch}.zip"

    def get_default_branch_fallback(self) -> str:
        """Gitee defaults to 'master' branch."""
        return "master"
