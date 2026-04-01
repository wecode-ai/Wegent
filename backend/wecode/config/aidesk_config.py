# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Aidesk authentication configuration.

Loads Aidesk SSO configuration from global settings.
Used for signature verification when 口袋 App WebView accesses Wegent.
"""

from dataclasses import dataclass

from app.core.config import settings


@dataclass
class AideskConfig:
    """Aidesk SSO authentication configuration."""

    # Shared secret key for signature verification (must match 口袋 App)
    secret_key: str = ""

    # Timestamp validation window in seconds (default: 300 seconds = 5 minutes)
    timestamp_window: int = 300

    # Enable/disable Aidesk authentication
    auth_enabled: bool = True

    @classmethod
    def from_settings(cls) -> "AideskConfig":
        """Load configuration from global settings."""
        return cls(
            secret_key=settings.AIDESK_SECRET_KEY,
            timestamp_window=settings.AIDESK_TIMESTAMP_WINDOW,
            auth_enabled=settings.AIDESK_AUTH_ENABLED,
        )

    def validate(self) -> bool:
        """Check if required configuration is present."""
        return bool(self.secret_key)


# Global config instance
aidesk_config = AideskConfig.from_settings()
