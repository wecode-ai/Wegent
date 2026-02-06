# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""GitLab repository provider implementation."""

from typing import Dict, Optional, Tuple
from urllib.parse import quote

from app.services.git_skill.models import RepoAuthInfo
from app.services.git_skill.providers.base import GitRepoProvider


class GitLabProvider(GitRepoProvider):
    """GitLab repository provider (supports gitlab.com and self-hosted)."""

    def __init__(self, host: str = "gitlab.com", base_url: str = ""):
        self.host = host
        # Use provided base_url or default to https://
        self.base_url = base_url if base_url else f"https://{host}"

    @property
    def name(self) -> str:
        return "GitLab"

    def get_api_url(self, owner: str, repo: str) -> str:
        """
        Get the GitLab API URL for repository info.

        For nested groups like "weibo_rd/common/wecode/wegent-skills",
        owner = "weibo_rd/common/wecode", repo = "wegent-skills"
        We need to encode the full path: "weibo_rd%2Fcommon%2Fwecode%2Fwegent-skills"
        """
        full_path = f"{owner}/{repo}"
        project_path = quote(full_path, safe="")
        return f"{self.base_url}/api/v4/projects/{project_path}"

    def get_api_headers(self, auth: RepoAuthInfo) -> Dict[str, str]:
        """Get API headers for GitLab authentication."""
        headers = {}
        if auth and auth.password:
            headers["PRIVATE-TOKEN"] = auth.password
        return headers

    def get_zip_auth(self, auth: RepoAuthInfo) -> Optional[Tuple[str, str]]:
        """Get authentication for ZIP download (not used for GitLab, use headers instead)."""
        return None

    def get_zip_headers(self, auth: RepoAuthInfo) -> Dict[str, str]:
        """Get headers for ZIP download authentication (GitLab uses PRIVATE-TOKEN header)."""
        headers = {}
        if auth and auth.password:
            headers["PRIVATE-TOKEN"] = auth.password
        return headers

    def get_zip_download_url(self, owner: str, repo: str, branch: str) -> str:
        """Get the URL to download the repository as a ZIP file."""
        return f"{self.base_url}/{owner}/{repo}/-/archive/{branch}/{repo}-{branch}.zip"
