# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Registry version checker for internal registry API.

Fetches update metadata from internal registry and compares semantic versions.
"""

import logging
import platform
from typing import Optional

from shared.utils.http_client import traced_session

from executor.services.updater.version_checker import UpdateInfo, VersionChecker

logger = logging.getLogger(__name__)


class RegistryVersionChecker(VersionChecker):
    """Version checker for internal registry API."""

    API_TIMEOUT = 30  # seconds

    def __init__(self, registry_url: str, auth_token: Optional[str] = None):
        """Initialize registry version checker.

        Args:
            registry_url: Base URL of registry API
            auth_token: Optional auth token for authentication
        """
        self.registry_url = registry_url
        self.auth_token = auth_token  # Can be None if not provided

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

    def _build_api_url(self) -> str:
        """Build the API URL for checking updates.

        Handles two cases:
        1. Base registry URL: https://example.com/registry
           -> https://example.com/registry/{binary_name}/update.json
        2. Already contains platform path: https://example.com/registry/wegent-executor-linux-amd64/update.json
           -> Use as-is (backward compatibility with old configs)

        Returns:
            Complete API URL for fetching update metadata
        """
        binary_name = self.get_binary_name()
        base_url = self.registry_url.rstrip("/")

        # Check if URL already ends with /update.json (old format with platform path)
        if base_url.endswith("/update.json"):
            return base_url

        # Check if URL already contains a binary name pattern (wegent-executor-)
        if "wegent-executor-" in base_url:
            # Extract the base path up to the registry root
            # URL format: .../registry/wegent-executor-{platform}/update.json
            return base_url

        # Standard format: append binary name and update.json
        return f"{base_url}/{binary_name}/update.json"

    async def check_for_updates(self, current_version: str) -> Optional[UpdateInfo]:
        """Check for updates from registry API.

        Args:
            current_version: Current executor version (e.g., "1.0.0")

        Returns:
            UpdateInfo if a newer version is available, None otherwise
        """
        api_url = self._build_api_url()

        headers = {}
        if self.auth_token:
            headers["PRIVATE-TOKEN"] = self.auth_token

        try:
            session = traced_session()
            response = session.get(
                api_url,
                headers=headers,
                timeout=self.API_TIMEOUT,
            )
            response.raise_for_status()

            data = response.json()
            latest_version = data.get("version")
            download_url = data.get("url")

            if not latest_version or not download_url:
                logger.warning("Invalid API response: missing version or url")
                return None

            # Compare versions
            if self.compare_versions(current_version, latest_version) < 0:
                return UpdateInfo(version=latest_version, url=download_url)
            else:
                # Already on latest or newer
                return None

        except Exception as e:
            error_msg = str(e)
            # Provide more helpful error messages for common issues
            if "SSL" in error_msg or "CERTIFICATE" in error_msg.upper():
                logger.warning(f"SSL error checking for updates: {e}")
            elif "Connection" in error_msg or "Name or service not known" in error_msg:
                logger.warning(f"Connection error (API may be unreachable): {e}")
            elif "Timeout" in error_msg:
                logger.warning(f"Timeout checking for updates: {e}")
            else:
                logger.warning(f"Failed to check for updates: {e}")
            return None
