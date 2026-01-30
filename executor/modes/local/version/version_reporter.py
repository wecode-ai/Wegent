# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Version reporter for local executor mode.

Reports executor version and handles version check responses.
"""

from typing import Dict, Optional

from shared.logger import setup_logger

logger = setup_logger("version_reporter")


def get_executor_version() -> str:
    """
    Get the current executor version.

    Returns:
        Version string (e.g., "1.0.0")
    """
    try:
        from executor.__version__ import __version__

        return __version__
    except ImportError:
        return "unknown"


class VersionReporter:
    """
    Manages version reporting and upgrade notifications.

    Features:
    - Report current version
    - Process version check responses from backend
    - Log upgrade notifications
    """

    def __init__(self):
        """Initialize the version reporter."""
        self._current_version = get_executor_version()
        self._latest_version: Optional[str] = None
        self._version_status: Optional[str] = None
        self._update_available = False

    def get_version(self) -> str:
        """
        Get the current executor version.

        Returns:
            Version string
        """
        return self._current_version

    def handle_version_response(self, response: Dict) -> None:
        """
        Handle version check response from backend.

        Args:
            response: Dict with version info from backend
                - latest_version: Latest available version
                - version_status: "up_to_date", "update_available", or "incompatible"
                - min_compatible_version: Minimum compatible version
                - release_notes: Optional release notes for new version
        """
        if not response:
            return

        self._latest_version = response.get("latest_version")
        self._version_status = response.get("version_status")
        self._update_available = self._version_status == "update_available"

        # Log version status
        if self._version_status == "update_available" and self._latest_version:
            logger.info(
                f"[VERSION] New version available: {self._latest_version}, "
                f"current: {self._current_version}"
            )
            release_notes = response.get("release_notes")
            if release_notes:
                logger.info(f"[VERSION] Release notes: {release_notes}")

        elif self._version_status == "incompatible":
            min_version = response.get("min_compatible_version", "unknown")
            logger.warning(
                f"[VERSION] Current version {self._current_version} is incompatible. "
                f"Minimum required: {min_version}"
            )

        elif self._version_status == "up_to_date":
            logger.debug(f"[VERSION] Executor is up to date: {self._current_version}")

    def get_version_status(self) -> Dict:
        """
        Get current version status.

        Returns:
            Dict with current_version, latest_version, version_status, update_available
        """
        return {
            "current_version": self._current_version,
            "latest_version": self._latest_version,
            "version_status": self._version_status,
            "update_available": self._update_available,
        }

    def reset(self) -> None:
        """Reset version status (e.g., after update)."""
        self._latest_version = None
        self._version_status = None
        self._update_available = False
