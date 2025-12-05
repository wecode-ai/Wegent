# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from pydantic_settings import BaseSettings


class WikiSettings(BaseSettings):
    """Wiki feature independent configuration"""

    # Wiki database configuration (env var: WIKI_DATABASE_URL)
    DATABASE_URL: str = "mysql+pymysql://user:password@localhost/wiki"

    # Wiki feature toggle (env var: WIKI_ENABLED)
    ENABLED: bool = True

    # Wiki task configuration (env vars: WIKI_DEFAULT_TEAM_ID, WIKI_DEFAULT_AGENT_TYPE, WIKI_DEFAULT_USER_ID)
    DEFAULT_TEAM_ID: int = 0  # Default execution team ID
    DEFAULT_AGENT_TYPE: str = "ClaudeCode"  # Default agent type
    DEFAULT_USER_ID: int = 0  # Default user ID for task creation (0 = use current user)

    # Wiki generation configuration (env vars: WIKI_MAX_CONCURRENT_GENERATIONS)
    MAX_CONCURRENT_GENERATIONS: int = 5  # Maximum concurrent generations
    RESULT_POLL_INTERVAL_SECONDS: int = 30  # Background polling interval
    RESULT_POLL_BATCH_SIZE: int = 20  # Background polling batch size

    # Wiki content configuration (env var: WIKI_MAX_CONTENT_SIZE)
    MAX_CONTENT_SIZE: int = 10 * 1024 * 1024  # Maximum content size 10MB
    SUPPORTED_FORMATS: list[str] = ["markdown", "html"]  # Supported formats
    CONTENT_WRITE_BASE_URL: str = (
        "http://localhost:8000"  # Base server address for internal wiki content writer
    )
    CONTENT_WRITE_ENDPOINT: str = (
        "/api/internal/wiki/generations/contents"  # Fixed relative path for content writes
    )
    DEFAULT_SECTION_TYPES: list[str] = [
        "overview",
        "architecture",
        "module",
        "api",
        "guide",
        "deep",
    ]
    INTERNAL_API_TOKEN: str = (
        "weki"  # Internal authentication token for content write API
    )

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"
        env_prefix = "WIKI_"  # Environment variable prefix
        extra = "ignore"  # Ignore extra fields from .env file


# Global wiki configuration instance
wiki_settings = WikiSettings()
