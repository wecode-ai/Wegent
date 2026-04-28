# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Service configuration for knowledge_runtime."""

from __future__ import annotations

from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Runtime service settings loaded from environment variables."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # Server configuration
    # Allow both KNOWLEDGE_RUNTIME_* prefixed env vars and simple names
    host: str = Field(
        default="0.0.0.0",
        validation_alias=AliasChoices("KNOWLEDGE_RUNTIME_HOST", "HOST"),
    )
    port: int = Field(
        default=8200,
        validation_alias=AliasChoices("KNOWLEDGE_RUNTIME_PORT", "PORT"),
    )

    # Backend URL for fetching content
    backend_internal_url: str = Field(
        default="http://localhost:8000",
        validation_alias=AliasChoices(
            "KNOWLEDGE_RUNTIME_BACKEND_INTERNAL_URL", "BACKEND_INTERNAL_URL"
        ),
    )

    # Content fetching timeout in seconds
    content_fetch_timeout: int = 120

    # Logging configuration
    log_file_enabled: bool = True  # Enable file logging by default
    log_dir: str = "./logs"  # Directory for log files
    log_level: str = "INFO"  # Log level (DEBUG, INFO, WARNING, ERROR, CRITICAL)

    # Internal service authentication token
    # When set, all /internal/rag/* endpoints (except health) require this token
    # Generate using: openssl rand -hex 32
    internal_service_token: str = ""

    # Database connection for config resolution
    database_url: str = Field(
        default="",
        validation_alias=AliasChoices("KNOWLEDGE_RUNTIME_DATABASE_URL", "DATABASE_URL"),
    )


# Global settings instance
_settings: Settings | None = None


def get_settings() -> Settings:
    """Get the global settings instance, creating it if necessary."""
    global _settings
    if _settings is None:
        _settings = Settings()
    return _settings


def reset_settings() -> None:
    """Reset the global settings instance (useful for testing)."""
    global _settings
    _settings = None
