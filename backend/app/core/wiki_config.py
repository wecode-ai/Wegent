# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from typing import Dict, Optional

from pydantic import BaseModel, ConfigDict, Field, model_validator
from pydantic_settings import BaseSettings


class CodeWikiTeamRef(BaseModel):
    """A Team selected by deployment policy, never by an API caller."""

    model_config = ConfigDict(populate_by_name=True)

    name: str = Field(..., min_length=1)
    namespace: str = Field("default", min_length=1)


class CodeWikiStrategyBinding(BaseModel):
    """Whether one known strategy is available and which Team implements it."""

    model_config = ConfigDict(populate_by_name=True)

    enabled: bool = True
    team_ref: CodeWikiTeamRef = Field(alias="teamRef")


class CodeWikiGenerationPolicy(BaseModel):
    """Deployment choices linking Code Wiki strategies to executable Teams."""

    model_config = ConfigDict(populate_by_name=True)

    default_strategy: str = Field(alias="defaultStrategy")
    legacy_fallback_strategy: str = Field(alias="legacyFallbackStrategy")
    strategies: Dict[str, CodeWikiStrategyBinding]

    @model_validator(mode="after")
    def defaults_are_enabled(self) -> "CodeWikiGenerationPolicy":
        for field_name, strategy_id in (
            ("defaultStrategy", self.default_strategy),
            ("legacyFallbackStrategy", self.legacy_fallback_strategy),
        ):
            binding = self.strategies.get(strategy_id)
            if binding is None or not binding.enabled:
                raise ValueError(f"{field_name} must name an enabled strategy")
        return self


def default_code_wiki_generation_policy(team_name: str) -> CodeWikiGenerationPolicy:
    """Preserve the existing single-Team deployment until policy is configured."""

    team_ref = CodeWikiTeamRef(name=team_name, namespace="default")
    return CodeWikiGenerationPolicy(
        defaultStrategy="legacy",
        legacyFallbackStrategy="legacy",
        strategies={
            "coordinator_reviewed": CodeWikiStrategyBinding(teamRef=team_ref),
            "legacy": CodeWikiStrategyBinding(teamRef=team_ref),
        },
    )


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
    # One structured policy replaces per-strategy Team settings. When absent, the
    # existing WIKI_CODE_WIKI_TEAM_NAME remains authoritative so upgrades do not
    # change a deployment before it opts into multiple strategies.
    CODE_WIKI_GENERATION_POLICY: Optional[CodeWikiGenerationPolicy] = None
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

    # Write-back channel (env var: WIKI_MAX_CONTENT_SIZE).
    # The agent reaches it through the wiki_submit skill, which builds the URL from
    # the task's own API domain -- so there is no configured address here to drift
    # out of step with where the backend actually is.
    MAX_CONTENT_SIZE: int = 10 * 1024 * 1024  # Maximum content size 10MB

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"
        env_prefix = "WIKI_"  # Environment variable prefix
        extra = "ignore"  # Ignore extra fields from .env file


# Global wiki configuration instance
wiki_settings = WikiSettings()
