# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Version checker abstract base class for executor self-update.

Defines the interface for version checking strategies.
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Optional


@dataclass
class UpdateInfo:
    """Update information from API.

    Attributes:
        version: Latest version string (e.g., "1.6.6")
        url: Download URL for the new binary
    """

    version: str
    url: str


class VersionChecker(ABC):
    """Abstract base class for version checking strategies."""

    @abstractmethod
    async def check_for_updates(self, current_version: str) -> Optional[UpdateInfo]:
        """Check for updates. Returns UpdateInfo if available, None otherwise.

        Args:
            current_version: Current executor version (e.g., "1.0.0")

        Returns:
            UpdateInfo if a newer version is available, None otherwise
        """
        pass

    @staticmethod
    @abstractmethod
    def get_binary_name() -> str:
        """Get platform-specific binary name.

        Returns:
            Platform-specific binary name for API lookup
        """
        pass

    @staticmethod
    def compare_versions(current: str, latest: str) -> int:
        """Compare two semantic version strings.

        Args:
            current: Current version string (e.g., "1.0.0")
            latest: Latest version string (e.g., "1.6.6")

        Returns:
            -1 if current < latest (update needed)
             0 if current == latest
             1 if current > latest (ahead of remote)
        """
        try:
            current_parts = [int(x) for x in current.split(".")]
            latest_parts = [int(x) for x in latest.split(".")]

            # Pad with zeros to match length
            max_len = max(len(current_parts), len(latest_parts))
            current_parts.extend([0] * (max_len - len(current_parts)))
            latest_parts.extend([0] * (max_len - len(latest_parts)))

            for c, l in zip(current_parts, latest_parts):
                if c < l:
                    return -1
                elif c > l:
                    return 1
            return 0
        except (ValueError, AttributeError):
            # Fallback to string comparison for non-standard versions
            if current < latest:
                return -1
            elif current > latest:
                return 1
            return 0
