# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Configuration settings for Chat Shell Service."""

from typing import Tuple, Type

from pydantic import Field
from pydantic_settings import (
    BaseSettings,
    PydanticBaseSettingsSource,
    SettingsConfigDict,
)


class Settings(BaseSettings):
    """Chat Shell Service configuration settings."""

    # Project configuration
    PROJECT_NAME: str = "Chat Shell Service"
    API_PREFIX: str = "/api"
    ENABLE_API_DOCS: bool = True

    # Environment configuration
    ENVIRONMENT: str = "development"  # development or production

    # ========== Running Mode ==========
    # "package" - used as a Python package imported by Backend
    # "http" - runs as an independent HTTP service (default)
    # "cli" - command-line interface mode
    # Env: CHAT_SHELL_MODE
    MODE: str = "http"

    @property
    def CHAT_SHELL_MODE(self) -> str:
        """Backward compatibility property for MODE setting."""
        return self.MODE

    # ========== Storage Configuration ==========
    # "memory" - in-memory storage (for testing)
    # "sqlite" - local SQLite storage (for CLI)
    # "remote" - calls Backend API (for production HTTP mode)
    # Env: CHAT_SHELL_STORAGE_TYPE
    STORAGE_TYPE: str = "remote"

    # SQLite configuration (for CLI)
    SQLITE_DB_PATH: str = "~/.chat_shell/history.db"

    # Remote storage configuration (calls Backend API)
    # Default: http://backend:8000/api/internal (Docker) or http://localhost:8000/api/internal (local)
    REMOTE_STORAGE_URL: str = "http://localhost:8000/api/internal"
    REMOTE_STORAGE_TOKEN: str = ""

    # ========== HTTP Server Configuration ==========
    HTTP_HOST: str = "0.0.0.0"
    HTTP_PORT: int = 8001

    # Database configuration (for package mode, shared with Backend)
    DATABASE_URL: str = "mysql+asyncmy://user:password@localhost/task_manager"

    # Internal service authentication
    INTERNAL_SERVICE_TOKEN: str = ""

    # ========== LLM API Keys ==========
    ANTHROPIC_API_KEY: str = ""
    OPENAI_API_KEY: str = ""
    GOOGLE_API_KEY: str = ""

    # ========== Default Model Configuration ==========
    DEFAULT_MODEL: str = "claude-3-5-sonnet-20241022"
    DEFAULT_TEMPERATURE: float = 0.7
    DEFAULT_MAX_TOKENS: int = 4096

    # ========== Chat Configuration ==========
    MAX_CONCURRENT_CHATS: int = 50
    CHAT_HISTORY_EXPIRE_SECONDS: int = 7200
    CHAT_HISTORY_MAX_MESSAGES: int = 50
    CHAT_API_TIMEOUT_SECONDS: int = 300

    # Tool calling flow limits
    CHAT_TOOL_MAX_REQUESTS: int = 10
    CHAT_TOOL_MAX_TIME_SECONDS: float = 60.0

    # Group chat history configuration
    GROUP_CHAT_HISTORY_FIRST_MESSAGES: int = 10
    GROUP_CHAT_HISTORY_LAST_MESSAGES: int = 20

    # Message compression configuration
    MESSAGE_COMPRESSION_ENABLED: bool = True
    MESSAGE_COMPRESSION_FIRST_MESSAGES: int = 2
    MESSAGE_COMPRESSION_LAST_MESSAGES: int = 10
    MESSAGE_COMPRESSION_ATTACHMENT_LENGTH: int = 50000

    # MCP configuration for Chat Shell
    CHAT_MCP_ENABLED: bool = False
    CHAT_MCP_SERVERS: str = "{}"

    # Web search configuration
    WEB_SEARCH_ENABLED: bool = False
    WEB_SEARCH_ENGINES: str = "{}"
    WEB_SEARCH_DEFAULT_MAX_RESULTS: int = 50

    # Workspace configuration
    WORKSPACE_ROOT: str = "/workspace"
    ENABLE_SKILLS: bool = True
    ENABLE_CHECKPOINTING: bool = False

    # Attachment/Context configuration
    MAX_EXTRACTED_TEXT_LENGTH: int = 100000

    # Backend RAG service configuration (for knowledge base HTTP fallback)
    BACKEND_RAG_URL: str = "http://localhost:8000/api/knowledge/v1/retrieve"

    # OpenTelemetry configuration
    OTEL_ENABLED: bool = False

    # Graceful shutdown
    GRACEFUL_SHUTDOWN_TIMEOUT: int = 600

    # Data Table Configuration
    # JSON string containing table provider credentials (DingTalk, etc.)
    # Format: {"dingtalk":{"appKey":"...","appSecret":"...","operatorId":"...","userMapping":{...}}}
    # This is shared configuration between backend and chat_shell, uses validation_alias to read from DATA_TABLE_CONFIG (no prefix)
    DATA_TABLE_CONFIG: str = Field(default="", validation_alias="DATA_TABLE_CONFIG")

    @classmethod
    def settings_customise_sources(
        cls,
        settings_cls: Type[BaseSettings],
        init_settings: PydanticBaseSettingsSource,
        env_settings: PydanticBaseSettingsSource,
        dotenv_settings: PydanticBaseSettingsSource,
        file_secret_settings: PydanticBaseSettingsSource,
    ) -> Tuple[PydanticBaseSettingsSource, ...]:
        """Customize settings sources."""
        return (
            init_settings,
            env_settings,
            dotenv_settings,
            file_secret_settings,
        )

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        env_prefix="CHAT_SHELL_",
        extra="ignore",
        populate_by_name=True,  # Allow reading from field name without prefix
    )


# Global configuration instance
settings = Settings()
