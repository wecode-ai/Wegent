# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Published apps service configuration."""

from pydantic_settings import BaseSettings, SettingsConfigDict

DEFAULT_PUBLISHED_APPS_API_URL = "http://10.37.255.188:3001"
DEFAULT_PUBLISHED_APPS_TIMEOUT_SECONDS = 10.0


class PublishedAppsSettings(BaseSettings):
    """Configuration for the internal published apps service."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # Runtime values take precedence in deployed containers.
    RUNTIME_PUBLISHED_APPS_API_URL: str = ""
    RUNTIME_PUBLISHED_APPS_API_TOKEN: str = ""

    # Local/deployment fallback values.
    PUBLISHED_APPS_API_URL: str = DEFAULT_PUBLISHED_APPS_API_URL
    PUBLISHED_APPS_API_TOKEN: str = ""
    PUBLISHED_APPS_TIMEOUT_SECONDS: float = DEFAULT_PUBLISHED_APPS_TIMEOUT_SECONDS

    @property
    def base_url(self) -> str:
        """Return the effective published apps service base URL."""
        return (
            self.RUNTIME_PUBLISHED_APPS_API_URL or self.PUBLISHED_APPS_API_URL
        ).rstrip("/")

    @property
    def api_token(self) -> str:
        """Return the effective published apps service bearer token."""
        return self.RUNTIME_PUBLISHED_APPS_API_TOKEN or self.PUBLISHED_APPS_API_TOKEN
