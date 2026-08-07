# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from pydantic_settings import BaseSettings


class WikiSettings(BaseSettings):
    """Configuration for code wikis and the write-back channel they use.

    There used to be a second set beside this one, for the legacy wiki: its own team,
    its own account, its own toggle, its own section types. Both were live and only
    one was reachable, so the answer to "which team runs this" depended on which of
    two code paths you happened to be reading. The legacy path is gone and so is its
    configuration.
    """

    # Team that runs code wikis (env var: WIKI_CODE_WIKI_TEAM_NAME).
    CODE_WIKI_TEAM_NAME: str = (
        "code-wiki-team"  # Matches init_data/02-public-resources.yaml
    )
    # Whether new code wikis may be created (env var: WIKI_CODE_WIKI_ENABLED).
    #
    # On by default, because a deployment that never sets it should not have a
    # feature that silently refuses. The staged rollout is decided on the frontend,
    # by RUNTIME_ENABLE_CODE_WIKI, which is off by default and is what stops the
    # option being offered; this one exists to refuse the call outright when a
    # deployment wants it off no matter what any client asks.
    #
    # It gates creation only: wikis that already exist stay readable and stay able to
    # regenerate, because turning a rollout down should stop it spreading, not break
    # what it already produced.
    CODE_WIKI_ENABLED: bool = True
    DEFAULT_LANGUAGE: str = (
        "en"  # Default language for wiki documentation generation (en/zh)
    )

    # Write-back channel (env vars: WIKI_MAX_CONTENT_SIZE, WIKI_INTERNAL_API_TOKEN).
    # The agent reaches it through the wiki_submit skill, which builds the URL from
    # the task's own API domain -- so there is no configured address here to drift
    # out of step with where the backend actually is.
    MAX_CONTENT_SIZE: int = 10 * 1024 * 1024  # Maximum content size 10MB
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
