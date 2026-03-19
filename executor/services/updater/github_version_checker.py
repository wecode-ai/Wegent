# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""GitHub version checker for GitHub Releases.

Fetches update metadata from GitHub Releases API and compares semantic versions.
"""

import logging
import platform
from typing import Optional

from shared.utils.http_client import traced_session

from executor.services.updater.version_checker import UpdateInfo, VersionChecker

logger = logging.getLogger(__name__)


class GithubVersionChecker(VersionChecker):
    """Version checker for GitHub Releases."""

    # Embedded github repo for PyInstaller builds (set by build script)
    # This will be replaced during the build process
    _EMBEDDED_GITHUB_REPO: Optional[str] = None

    # Default repo (fallback)
    DEFAULT_GITHUB_REPO = "wecode-ai/Wegent"
    API_BASE = "https://api.github.com"
    API_TIMEOUT = 30  # seconds

    def __init__(self, github_token: Optional[str] = None):
        """Initialize GitHub version checker.

        Args:
            github_token: Optional GitHub token (increases rate limit)
        """
        self.github_token = github_token

    def _get_github_repo(self) -> str:
        """Get GitHub repo (embedded or default).

        Returns:
            GitHub repo in format "owner/repo"
        """
        if self._EMBEDDED_GITHUB_REPO is not None:
            return self._EMBEDDED_GITHUB_REPO
        return self.DEFAULT_GITHUB_REPO

    @staticmethod
    def get_binary_name() -> str:
        """Generate platform-specific binary name.

        Maps platform.system() and platform.machine() to binary naming convention:
        - Darwin + arm64 -> wegent-executor-macos-arm64
        - Darwin + x86_64 -> wegent-executor-macos-amd64
        - Linux + arm64 -> wegent-executor-linux-arm64
        - Linux + x86_64 -> wegent-executor-linux-amd64
        - Windows + AMD64 -> wegent-executor-windows-amd64

        Returns:
            Platform-specific binary name for API lookup
        """
        system = platform.system().lower()
        machine = platform.machine().lower()

        # Map system names
        if system == "darwin":
            os_name = "macos"
        elif system == "windows":
            os_name = "windows"
        else:
            os_name = "linux"

        # Map architecture names
        if machine in ("x86_64", "amd64"):
            arch = "amd64"
        elif machine in ("arm64", "aarch64"):
            arch = "arm64"
        else:
            # Fallback for other architectures
            arch = machine

        return f"wegent-executor-{os_name}-{arch}"

    async def check_for_updates(self, current_version: str) -> Optional[UpdateInfo]:
        """Check for updates from GitHub Releases.

        Args:
            current_version: Current executor version (e.g., "1.0.0")

        Returns:
            UpdateInfo if a newer version is available, None otherwise
        """
        api_url = f"{self.API_BASE}/repos/{self._get_github_repo()}/releases/latest"

        headers = {"Accept": "application/vnd.github+json"}
        if self.github_token:
            headers["Authorization"] = f"Bearer {self.github_token}"

        try:
            session = traced_session()
            response = session.get(api_url, headers=headers, timeout=self.API_TIMEOUT)
            response.raise_for_status()

            data = response.json()
            tag_name = data.get("tag_name", "")

            # Strip 'v' prefix from tag (e.g., "v1.6.6" -> "1.6.6")
            latest_version = tag_name.lstrip("v")

            # Find matching binary asset
            binary_name = self.get_binary_name()
            assets = data.get("assets", [])
            download_url = None

            for asset in assets:
                if asset.get("name") == binary_name:
                    download_url = asset.get("browser_download_url")
                    break

            if not download_url:
                logger.warning(
                    f"No binary found for {binary_name} in release {tag_name}. "
                    "This platform may not be supported."
                )
                return None

            # Compare versions
            if self.compare_versions(current_version, latest_version) < 0:
                return UpdateInfo(version=latest_version, url=download_url)
            else:
                return None

        except Exception as e:
            error_msg = str(e)
            # Handle GitHub-specific errors
            if "403" in error_msg:
                logger.warning(
                    "GitHub API rate limit exceeded. "
                    "Consider providing a GitHub token in config."
                )
            elif "404" in error_msg:
                logger.warning("GitHub repository not found or is private.")
            else:
                logger.warning(f"Failed to check for updates from GitHub: {e}")
            return None
