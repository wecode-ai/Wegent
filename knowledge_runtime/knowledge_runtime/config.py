# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Service configuration for knowledge_runtime."""

from __future__ import annotations

from typing import Any

from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict

from shared.event_reporting.config import EventReporterConfig


class Settings(BaseSettings):
    """Runtime service settings loaded from environment variables."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # Optional logging must not make application settings validation fatal.
    EVENT_REPORTING_ENABLED: Any = False
    EVENT_KAFKA_ADV_ATTRIBUTION_ENABLED: Any = False
    EVENT_KAFKA_ADV_READ_WIKI_ENABLED: Any = False
    EVENT_KAFKA_ADV_MODEL_STORAGE_ENABLED: Any = False
    EVENT_KAFKA_ADV_QUALITY_DETAIL_ENABLED: Any = False
    EVENT_KAFKA_ADV_RESULT_DETAIL_LIMIT: Any = 10
    EVENT_KAFKA_BOOTSTRAP_SERVERS: Any = ""
    EVENT_KAFKA_TOPIC: Any = "knowledge-events-v1"
    EVENT_KAFKA_ENVIRONMENT: Any = ""
    EVENT_KAFKA_CLIENT_ID: Any = ""
    EVENT_KAFKA_ACKS: Any = "all"
    EVENT_KAFKA_COMPRESSION_TYPE: Any = "lz4"
    EVENT_KAFKA_LINGER_MS: Any = 20
    EVENT_KAFKA_REQUEST_TIMEOUT_MS: Any = 5_000
    EVENT_KAFKA_DELIVERY_TIMEOUT_MS: Any = 5_000
    EVENT_KAFKA_QUEUE_MAX_BYTES: Any = 16 * 1024 * 1024
    EVENT_KAFKA_EVENT_MAX_BYTES: Any = 8 * 1024
    EVENT_KAFKA_SHUTDOWN_TIMEOUT_MS: Any = 8_000
    EVENT_KAFKA_SECURITY_PROTOCOL: Any = "PLAINTEXT"
    EVENT_KAFKA_SASL_MECHANISM: Any = "PLAIN"
    EVENT_KAFKA_SASL_USERNAME: Any = Field(default="", repr=False)
    EVENT_KAFKA_SASL_PASSWORD: Any = Field(default="", repr=False)
    EVENT_KAFKA_SSL_CAFILE: Any = ""

    def event_reporter_config(self, service_name: str) -> EventReporterConfig:
        return EventReporterConfig.from_mapping(self.__dict__, service_name)

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

    # Content fetching timeout in seconds
    content_fetch_timeout: int = Field(
        default=120,
        validation_alias=AliasChoices(
            "KNOWLEDGE_RUNTIME_CONTENT_FETCH_TIMEOUT", "CONTENT_FETCH_TIMEOUT"
        ),
    )

    # Logging configuration
    log_file_enabled: bool = Field(
        default=True,
        validation_alias=AliasChoices(
            "KNOWLEDGE_RUNTIME_LOG_FILE_ENABLED", "LOG_FILE_ENABLED"
        ),
    )
    log_dir: str = Field(
        default="./logs",
        validation_alias=AliasChoices("KNOWLEDGE_RUNTIME_LOG_DIR", "LOG_DIR"),
    )
    log_level: str = Field(
        default="INFO",
        validation_alias=AliasChoices("KNOWLEDGE_RUNTIME_LOG_LEVEL", "LOG_LEVEL"),
    )

    # Internal service authentication token
    # When set, all /internal/rag/* endpoints (except health) require this token
    # Generate using: openssl rand -hex 32
    internal_service_token: str = Field(
        default="",
        validation_alias=AliasChoices(
            "KNOWLEDGE_RUNTIME_INTERNAL_SERVICE_TOKEN", "INTERNAL_SERVICE_TOKEN"
        ),
    )

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
