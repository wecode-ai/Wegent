# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from pydantic_settings import BaseSettings


class WikiSettings(BaseSettings):
    """Wiki feature independent configuration"""

    # Wiki tables now use main database (task_manager)
    # DATABASE_URL configuration removed - wiki tables share the main database

    # Wiki feature toggle (env var: WIKI_ENABLED)
    ENABLED: bool = True

    # Wiki task configuration (env vars: WIKI_DEFAULT_TEAM_NAME, WIKI_DEFAULT_AGENT_TYPE, WIKI_DEFAULT_USER_ID, WIKI_DEFAULT_LANGUAGE)
    DEFAULT_TEAM_NAME: str = (
        "wiki-team"  # Default execution team name (matches init_data/01-default-resources.yaml)
    )
    DEFAULT_AGENT_TYPE: str = "ClaudeCode"  # Default agent type
    # Team that runs knowledge-base code wikis (env var: WIKI_CODE_WIKI_TEAM_NAME).
    # Separate from DEFAULT_TEAM_NAME because the two paths hand their agents
    # different instructions and different submission rules; pointing both at one team
    # would give the legacy wiki the page-path write contract it cannot satisfy.
    CODE_WIKI_TEAM_NAME: str = (
        "code-wiki-team"  # Matches init_data/02-public-resources.yaml
    )
    # Whether new code wikis may be created (env var: WIKI_CODE_WIKI_ENABLED).
    #
    # Off by default, so a deployment opts in rather than having to remember to opt
    # out everywhere but the pilot group. It gates creation only: wikis that already
    # exist stay readable and stay able to regenerate, because turning a rollout down
    # should stop it spreading, not break what it already produced.
    CODE_WIKI_ENABLED: bool = False
    DEFAULT_USER_ID: int = 0  # Default user ID for task creation (0 = use current user)
    DEFAULT_LANGUAGE: str = (
        "en"  # Default language for wiki documentation generation (en/zh)
    )

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
