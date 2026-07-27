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

    # Business read-only replica for stat collectors
    database_readonly_url: str = Field(
        default="",
        validation_alias=AliasChoices(
            "KNOWLEDGE_RUNTIME_DATABASE_READONLY_URL", "DATABASE_READONLY_URL"
        ),
    )

    # Stat database (dedicated physical DB for statistics)
    # Falls back to database_url when not configured
    knowledge_stat_database_url: str = Field(
        default="",
        validation_alias=AliasChoices("KNOWLEDGE_STAT_DATABASE_URL"),
    )

    # Celery broker (shared Redis)
    celery_broker_url: str = Field(
        default="",
        validation_alias=AliasChoices("CELERY_BROKER_URL", "REDIS_URL"),
    )

    # Celery result backend
    celery_result_backend: str = Field(
        default="",
        validation_alias=AliasChoices("CELERY_RESULT_BACKEND", "REDIS_URL"),
    )

    # KB stat worker toggle
    kb_stat_worker_enabled: bool = Field(
        default=True,
        validation_alias=AliasChoices("KB_STAT_WORKER_ENABLED"),
    )

    # KB stat master switch. When false, /internal/kb-stat/* endpoints
    # (except /health) return 503 and the runtime reports enabled=false
    # in the health response. Beat registration happens on the backend
    # side (it owns celery beat); this switch is for the HTTP layer.
    kb_stat_enabled: bool = Field(
        default=True,
        validation_alias=AliasChoices("KB_STAT_ENABLED"),
    )

    # Prune task switch (mirrors backend's KB_STAT_PRUNE_ENABLED for
    # health-reporting purposes — the actual beat removal happens on the
    # backend). When false the health endpoint reports prune_enabled=false
    # so operators can verify the retain-forever mode from one place.
    kb_stat_prune_enabled: bool = Field(
        default=True,
        validation_alias=AliasChoices("KB_STAT_PRUNE_ENABLED"),
    )

    # Auto-migrate on startup (default false: migrations should be managed
    # explicitly via `alembic upgrade head` in production deployments).
    kb_stat_auto_migrate: bool = Field(
        default=False,
        validation_alias=AliasChoices("KB_STAT_AUTO_MIGRATE"),
    )

    # Stat lookback window (days)
    knowledge_stat_lookback_days: int = Field(
        default=30,
        validation_alias=AliasChoices("KNOWLEDGE_STAT_LOOKBACK_DAYS"),
    )

    # Stat retention (days)
    knowledge_stat_retention_days: int = Field(
        default=400,
        validation_alias=AliasChoices("KNOWLEDGE_STAT_RETENTION_DAYS"),
    )

    # Comma-separated domains to collect (empty = all)
    kb_stat_domains: str = Field(
        default="",
        validation_alias=AliasChoices("KB_STAT_DOMAINS"),
    )

    # Minutes before a stuck "running" run is marked as failed
    kb_stat_stale_minutes: int = Field(
        default=120,
        validation_alias=AliasChoices("KB_STAT_STALE_MINUTES"),
    )

    # TTL (seconds) of the per-target_date collection lock. Must STRICTLY
    # exceed the celery task time_limit (default 1800s) so a crashed worker
    # auto-releases the lock instead of leaving the date permanently locked.
    # Default is time_limit + 300s buffer.
    kb_stat_lock_ttl_seconds: int = Field(
        default=2100,
        validation_alias=AliasChoices("KB_STAT_LOCK_TTL_SECONDS"),
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
