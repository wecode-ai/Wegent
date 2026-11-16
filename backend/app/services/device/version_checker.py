# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Version checkers for fetching executor latest version."""

import asyncio
import logging
import re
from abc import ABC, abstractmethod
from typing import Optional

from shared.utils.http_client import traced_session

logger = logging.getLogger(__name__)


class VersionInfo:
    """Version information from remote source."""

    def __init__(self, version: str, download_url: str):
        self.version = version
        self.download_url = download_url


class VersionChecker(ABC):
    """Abstract base class for version checking strategies."""

    @abstractmethod
    async def get_latest_version(self) -> Optional[VersionInfo]:
        """Get latest version information.

        Returns:
            VersionInfo if successful, None otherwise
        """
        pass


class GithubVersionChecker(VersionChecker):
    """Fetch latest version from GitHub Releases API."""

    API_BASE = "https://api.github.com"
    API_TIMEOUT = 30
    GITHUB_REPO = "wecode-ai/Wegent"  # Embedded default (same as executor)

    def __init__(self, token: Optional[str] = None):
        self.token = token

    def _fetch_latest_version(self) -> Optional[VersionInfo]:
        headers = {
            "Accept": "application/vnd.github+json",
            "User-Agent": "wegent-backend",
        }
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"

        try:
            session = traced_session()
            page = 1
            while True:
                api_url = (
                    f"{self.API_BASE}/repos/{self.GITHUB_REPO}/releases"
                    f"?per_page=100&page={page}"
                )
                response = session.get(
                    api_url, headers=headers, timeout=self.API_TIMEOUT
                )
                response.raise_for_status()
                releases = response.json()
                if not isinstance(releases, list):
                    raise ValueError("Invalid GitHub releases response")
                for release in releases:
                    tag = release.get("tag_name", "")
                    if (
                        not release.get("draft")
                        and not release.get("prerelease")
                        and re.fullmatch(r"v?[0-9]+\.[0-9]+\.[0-9]+", tag)
                    ):
                        version = tag.removeprefix("v")
                        logger.info("Fetched executor platform version: %s", version)
                        return VersionInfo(version=version, download_url="")
                if len(releases) < 100:
                    return None
                page += 1
        except Exception as e:
            logger.warning(f"Failed to fetch version from GitHub: {e}")
            return None

    async def get_latest_version(self) -> Optional[VersionInfo]:
        """Fetch latest release from GitHub without blocking the event loop."""
        return await asyncio.to_thread(self._fetch_latest_version)


class RegistryVersionChecker(VersionChecker):
    """Fetch latest version from internal registry API."""

    API_TIMEOUT = 30
    """all platform binary is same version"""
    BINARY_NAME = "wegent-executor-linux-amd64"

    def __init__(self, registry_url: str, auth_token: Optional[str] = None):
        self.registry_url = registry_url
        self.auth_token = auth_token

    def _build_api_url(self) -> str:
        """Build registry API URL."""
        base_url = self.registry_url.rstrip("/")
        if base_url.endswith("/update.json"):
            return base_url
        if "wegent-executor-" in base_url:
            return base_url
        # Default: assume URL points to registry root, append binary name and update.json
        return f"{base_url}/{self.BINARY_NAME}/update.json"

    def _fetch_latest_version(self) -> Optional[VersionInfo]:
        api_url = self._build_api_url()
        headers = {}
        if self.auth_token:
            headers["PRIVATE-TOKEN"] = self.auth_token

        try:
            session = traced_session()
            logger.debug(f"Fetching version from registry: {api_url}")
            response = session.get(api_url, headers=headers, timeout=self.API_TIMEOUT)
            response.raise_for_status()

            data = response.json()
            version = data.get("version")
            url = data.get("url", "")
            if version:
                logger.info(f"Fetched version from registry ({api_url}): {version}")
                return VersionInfo(version=version, download_url=url)
            logger.warning(f"No version found in registry response from {api_url}")
            return None
        except Exception as e:
            logger.warning(f"Failed to fetch version from registry: {e}")
            return None

    async def get_latest_version(self) -> Optional[VersionInfo]:
        """Fetch latest version from registry without blocking the event loop."""
        return await asyncio.to_thread(self._fetch_latest_version)
