# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from pathlib import Path
from typing import Any, Mapping, Optional, Tuple, Type

from dotenv import dotenv_values
from pydantic import field_validator
from pydantic_settings import (
    BaseSettings,
    PydanticBaseSettingsSource,
    SettingsConfigDict,
)
from pydantic_settings.sources import DotEnvSettingsSource
from pydantic_settings.sources.utils import parse_env_vars


class NoInterpolationDotEnvSettingsSource(DotEnvSettingsSource):
    """
    Custom DotEnvSettingsSource that disables variable interpolation.

    This fixes an issue where dotenv's default interpolation behavior
    incorrectly parses template variables like ${{user.name}} in JSON strings,
    turning them into "}".
    """

    @staticmethod
    def _static_read_env_file(
        file_path: Path,
        *,
        encoding: str | None = None,
        case_sensitive: bool = False,
        ignore_empty: bool = False,
        parse_none_str: str | None = None,
    ) -> Mapping[str, str | None]:
        # Disable interpolation to preserve template variables like ${{user.name}}
        file_vars: dict[str, str | None] = dotenv_values(
            file_path, encoding=encoding or "utf8", interpolate=False
        )
        return parse_env_vars(file_vars, case_sensitive, ignore_empty, parse_none_str)


class Settings(BaseSettings):
    # Project configuration
    PROJECT_NAME: str = "Task Manager Backend"
    VERSION: str = "1.0.0"
    API_PREFIX: str = "/api"
    # API docs toggle (from env ENABLE_API_DOCS, default True)
    ENABLE_API_DOCS: bool = True

    # Environment configuration
    ENVIRONMENT: str = "development"  # development or production

    # Database configuration
    DATABASE_URL: str = "mysql+asyncmy://user:password@localhost/task_manager"

    # Database auto-migration configuration (only in development)
    DB_AUTO_MIGRATE: bool = True

    # Executor configuration
    EXECUTOR_DELETE_TASK_URL: str = (
        "http://localhost:8001/executor-manager/executor/delete"
    )
    EXECUTOR_CANCEL_TASK_URL: str = (
        "http://localhost:8001/executor-manager/tasks/cancel"
    )

    # JWT configuration
    SECRET_KEY: str = "secret-key"
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 7 * 24 * 60  # 7 days in minutes

    # OIDC state configuration
    OIDC_STATE_SECRET_KEY: str = "test"
    OIDC_STATE_EXPIRE_SECONDS: int = 10 * 60  # 10 minutes, unit: seconds

    # Cache configuration
    REPO_CACHE_EXPIRED_TIME: int = 7200  # 2 hour in seconds
    REPO_UPDATE_INTERVAL_SECONDS: int = 3600  # 1 hour in seconds

    # Task limits
    MAX_RUNNING_TASKS_PER_USER: int = 10

    # Direct chat configuration
    MAX_CONCURRENT_CHATS: int = 50  # Maximum concurrent direct chat sessions
    CHAT_HISTORY_EXPIRE_SECONDS: int = 7200  # Chat history expiration (2 hours)
    CHAT_HISTORY_MAX_MESSAGES: int = 50  # Maximum messages to keep in history
    CHAT_API_TIMEOUT_SECONDS: int = 300  # LLM API call timeout (5 minutes)

    # Tool calling flow limits
    CHAT_TOOL_MAX_REQUESTS: int = 10  # Maximum LLM requests in tool calling flow
    CHAT_TOOL_MAX_TIME_SECONDS: float = (
        60.0  # Maximum time for tool calling flow (5 minutes)
    )
    # Group chat history configuration
    # In group chat mode, AI-bot sees: first N messages + last M messages (no duplicates)
    # If total messages < N + M, all messages are kept
    GROUP_CHAT_HISTORY_FIRST_MESSAGES: int = 10  # Number of first messages to keep
    GROUP_CHAT_HISTORY_LAST_MESSAGES: int = 20  # Number of last messages to keep

    # Streaming incremental save configuration
    STREAMING_REDIS_SAVE_INTERVAL: float = 1.0  # Redis save interval (seconds)
    STREAMING_DB_SAVE_INTERVAL: float = 5.0  # Database save interval (seconds)
    STREAMING_REDIS_TTL: int = 300  # Redis streaming cache TTL (seconds)
    STREAMING_MIN_CHARS_TO_SAVE: int = 50  # Minimum characters to save on disconnect

    # Task append expiration (hours)
    APPEND_CHAT_TASK_EXPIRE_HOURS: int = 2
    APPEND_CODE_TASK_EXPIRE_HOURS: int = 24

    # Subtask executor cleanup configuration
    # After a subtask is COMPLETED or FAILED, if executor_name/executor_namespace are set
    # and updated_at exceeds this threshold, the executor task will be deleted automatically.
    CHAT_TASK_EXECUTOR_DELETE_AFTER_HOURS: int = 2
    CODE_TASK_EXECUTOR_DELETE_AFTER_HOURS: int = 24
    # Cleanup scanning interval seconds
    TASK_EXECUTOR_CLEANUP_INTERVAL_SECONDS: int = 600

    # Frontend URL configuration
    FRONTEND_URL: str = "http://localhost:3000"

    # OIDC configuration
    OIDC_CLIENT_ID: str = "wegent"
    OIDC_CLIENT_SECRET: str = "test"
    OIDC_DISCOVERY_URL: str = "http://localhost:5556/.well-known/openid-configuration"
    OIDC_REDIRECT_URI: str = "http://localhost:8000/api/auth/oidc/callback"
    OIDC_CLI_REDIRECT_URI: str = "http://localhost:8000/api/auth/oidc/cli-callback"

    # Redis configuration
    REDIS_URL: str = "redis://127.0.0.1:6379/0"

    # Celery configuration
    CELERY_BROKER_URL: Optional[str] = None  # If None/empty, uses REDIS_URL
    CELERY_RESULT_BACKEND: Optional[str] = None  # If None/empty, uses REDIS_URL

    # Celery Beat scheduler configuration
    # "default" = SQLite file (single instance only)
    # "sqlalchemy" = MySQL database (multi-instance deployment)
    CELERY_BEAT_SCHEDULER: str = "default"
    # Database URL for Beat scheduler (only used when CELERY_BEAT_SCHEDULER="sqlalchemy")
    # If None/empty, uses DATABASE_URL
    CELERY_BEAT_DATABASE_URL: Optional[str] = None

    # Embedded Celery configuration
    # When True, Backend starts Celery worker/beat as daemon threads (for local dev)
    # When False, Celery must be started separately (for production)
    EMBEDDED_CELERY_ENABLED: bool = True

    @field_validator(
        "CELERY_BROKER_URL",
        "CELERY_RESULT_BACKEND",
        "CELERY_BEAT_DATABASE_URL",
        mode="before",
    )
    @classmethod
    def empty_str_to_none(cls, v: Any) -> Optional[str]:
        """Convert empty strings to None for proper fallback to REDIS_URL."""
        if isinstance(v, str) and v.strip() == "":
            return None
        return v

    # Scheduler backend configuration
    # Supported backends: "celery" (default), "apscheduler", "xxljob"
    SCHEDULER_BACKEND: str = "celery"

    # APScheduler configuration (only used when SCHEDULER_BACKEND="apscheduler")
    APSCHEDULER_JOB_STORE: str = "memory"  # "memory" or "sqlite"
    APSCHEDULER_SQLITE_PATH: str = "scheduler_jobs.db"

    # XXL-JOB configuration (only used when SCHEDULER_BACKEND="xxljob")
    XXLJOB_ADMIN_ADDRESSES: str = ""  # Comma-separated admin URLs
    XXLJOB_APP_NAME: str = "wegent-executor"
    XXLJOB_ACCESS_TOKEN: str = ""
    XXLJOB_EXECUTOR_PORT: int = 9999

    # Flow scheduler configuration
    FLOW_SCHEDULER_INTERVAL_SECONDS: int = 60
    FLOW_DEFAULT_TIMEOUT_SECONDS: int = 600  # 10 minutes
    FLOW_DEFAULT_RETRY_COUNT: int = 1
    FLOW_EXECUTION_PAGE_LIMIT: int = 50
    # Stale execution cleanup thresholds (hours)
    FLOW_STALE_PENDING_HOURS: int = (
        2  # PENDING executions older than this will be recovered
    )
    FLOW_STALE_RUNNING_HOURS: int = (
        3  # RUNNING executions older than this will be marked FAILED
    )

    # Circuit breaker configuration
    CIRCUIT_BREAKER_FAIL_MAX: int = 5  # Open circuit after 5 consecutive failures
    CIRCUIT_BREAKER_RESET_TIMEOUT: int = 60  # Try to recover after 60 seconds

    # Service extension module (empty = disabled)
    SERVICE_EXTENSION: str = ""

    # Team sharing configuration
    TEAM_SHARE_BASE_URL: str = "http://localhost:3000/chat"
    TASK_SHARE_BASE_URL: str = "http://localhost:3000"
    TEAM_SHARE_QUERY_PARAM: str = "teamShare"

    # AES encryption configuration for share tokens
    SHARE_TOKEN_AES_KEY: str = (
        "12345678901234567890123456789012"  # 32 bytes for AES-256
    )
    SHARE_TOKEN_AES_IV: str = "1234567890123456"  # 16 bytes for AES IV

    # Webhook notification configuration
    WEBHOOK_ENABLED: bool = False
    WEBHOOK_ENDPOINT_URL: str = ""
    WEBHOOK_HTTP_METHOD: str = "POST"
    WEBHOOK_AUTH_TYPE: str = ""
    WEBHOOK_AUTH_TOKEN: str = ""
    WEBHOOK_HEADERS: str = ""
    WEBHOOK_TIMEOUT: int = 30

    # YAML initialization configuration
    INIT_DATA_DIR: str = "/app/init_data"
    INIT_DATA_ENABLED: bool = True
    INIT_DATA_FORCE: bool = (
        False  # Force re-initialize YAML resources (delete and recreate)
    )

    # default header
    EXECUTOR_ENV: str = '{"DEFAULT_HEADERS":{"user":"${task_data.user.name}"}}'

    # File upload configuration
    MAX_UPLOAD_FILE_SIZE_MB: int = 100  # Maximum file size in MB
    MAX_EXTRACTED_TEXT_LENGTH: int = 500000  # Maximum extracted text length

    # Attachment storage backend configuration
    # Supported backends: "mysql" (default), "s3", "minio"
    # If not configured or set to "mysql", binary data is stored in MySQL database
    ATTACHMENT_STORAGE_BACKEND: str = "mysql"
    # S3/MinIO configuration (only used when ATTACHMENT_STORAGE_BACKEND is "s3" or "minio")
    ATTACHMENT_S3_ENDPOINT: str = (
        ""  # e.g., "https://s3.amazonaws.com" or "http://minio:9000"
    )
    ATTACHMENT_S3_ACCESS_KEY: str = ""
    ATTACHMENT_S3_SECRET_KEY: str = ""
    ATTACHMENT_S3_BUCKET: str = "attachments"
    ATTACHMENT_S3_REGION: str = "us-east-1"
    ATTACHMENT_S3_USE_SSL: bool = True

    # Attachment encryption configuration
    # Enable/disable AES-256-CBC encryption for attachment binary data
    # When enabled, all newly uploaded attachments will be encrypted
    # Existing unencrypted attachments remain accessible (backward compatible)
    ATTACHMENT_ENCRYPTION_ENABLED: bool = False
    # AES encryption key for attachments (32 bytes for AES-256)
    # SECURITY WARNING: Change this default value in production!
    # Generate using: openssl rand -hex 32
    ATTACHMENT_AES_KEY: str = "12345678901234567890123456789012"
    # AES initialization vector for attachments (16 bytes)
    # SECURITY WARNING: Change this default value in production!
    # Generate using: openssl rand -hex 16
    ATTACHMENT_AES_IV: str = "1234567890123456"

    OTEL_ENABLED: bool = False

    # Web scraper proxy configuration
    # Supports HTTP, HTTPS, SOCKS5 proxy formats:
    # - Simple: "http://proxy.example.com:8080"
    # - With auth: "http://user:pass@proxy.example.com:8080"
    # - SOCKS5: "socks5://proxy.example.com:1080"
    # If empty, no proxy will be used (direct connection)
    WEBSCRAPER_PROXY: str = ""
    # Proxy mode: "direct" or "fallback"
    # - "direct": Always use proxy for all requests (proxy must be configured)
    # - "fallback": Try direct connection first, use proxy only if direct fails
    # Default is "fallback" for better reliability
    WEBSCRAPER_PROXY_MODE: str = "fallback"

    # Web search configuration
    WEB_SEARCH_ENABLED: bool = False  # Enable/disable web search feature
    WEB_SEARCH_ENGINES: str = "{}"  # JSON configuration for search API adapter
    WEB_SEARCH_DEFAULT_MAX_RESULTS: int = (
        50  # Default max results when not specified by LLM or engine config
    )

    # Message compression configuration
    # Enable/disable automatic message compression when context limit is exceeded
    MESSAGE_COMPRESSION_ENABLED: bool = True
    # Number of first messages to keep during history truncation (system prompt + initial context)
    MESSAGE_COMPRESSION_FIRST_MESSAGES: int = 2
    # Number of last messages to keep during history truncation (recent context)
    MESSAGE_COMPRESSION_LAST_MESSAGES: int = 10
    # Maximum length for attachment content after truncation (characters)
    MESSAGE_COMPRESSION_ATTACHMENT_LENGTH: int = 50000

    # Wizard configuration
    # The name of the public model to use for wizard AI features (follow-up questions, prompt generation)
    # If not set or empty, wizard will try to find any available model (user's first, then public)
    WIZARD_MODEL_NAME: str = ""

    # MCP (Model Context Protocol) configuration for Chat Shell
    # Enable/disable MCP tools in Chat Shell mode
    CHAT_MCP_ENABLED: bool = False

    # Chat Shell mode configuration
    # "package" - use local app/chat_shell module directly (default, single process)
    # "http" - call external Chat Shell service via HTTP/SSE
    CHAT_SHELL_MODE: str = "http"
    # Chat Shell service URL (only used when CHAT_SHELL_MODE="http")
    CHAT_SHELL_URL: str = "http://localhost:8100"
    # Chat Shell service authentication token (only used when CHAT_SHELL_MODE="http")
    CHAT_SHELL_TOKEN: str = ""
    # Internal service authentication token (for HTTP mode communication)
    INTERNAL_SERVICE_TOKEN: str = ""
    # Backend internal URL (for service-to-service communication)
    # Used by chat_shell to download skill binaries
    BACKEND_INTERNAL_URL: str = "http://localhost:8000"

    # Streaming architecture mode configuration
    # "legacy" - WebSocketStreamingHandler directly emits to WebSocket (current behavior)
    # "bridge" - StreamingCore publishes to Redis channel, WebSocketBridge forwards to WebSocket
    STREAMING_MODE: str = "legacy"

    # Default team configuration for each mode
    # Format: "name#namespace" (namespace is optional, defaults to "default")
    DEFAULT_TEAM_CHAT: str = "wegent-chat#default"  # Default team for chat mode
    DEFAULT_TEAM_CODE: str = ""  # Default team for code mode
    DEFAULT_TEAM_KNOWLEDGE: str = (
        "wegent-notebook#default"  # Default team for knowledge mode
    )

    # JSON configuration for MCP servers (similar to Claude Desktop format)
    # Example:
    # {
    #     "mcpServers": {
    #         "image-gen": {
    #             "type": "sse",
    #             "url": "http://localhost:8080/sse",
    #             "headers": {"Authorization": "Bearer xxx"}
    #         },
    #         "ppt-gen": {
    #             "type": "stdio",
    #             "command": "npx",
    #             "args": ["-y", "@anthropic/ppt-mcp-server"],
    #             "env": {"API_KEY": "xxx"}
    #         }
    #     }
    # }
    # Supports ${{path}} variable substitution, e.g.:
    # "headers": {"X-User": "${{user.name}}"} will be replaced with actual username
    CHAT_MCP_SERVERS: str = "{}"

    # Maximum time to wait for active streaming requests to complete (seconds)
    # Default: 600 seconds (10 minutes) to allow long-running streaming requests to complete
    GRACEFUL_SHUTDOWN_TIMEOUT: int = 600
    # Whether to reject new requests during shutdown (503 Service Unavailable)
    SHUTDOWN_REJECT_NEW_REQUESTS: bool = True

    # Data Table Configuration
    # JSON string containing table provider credentials (DingTalk, etc.)
    # Format: {"dingtalk":{"appKey":"...","appSecret":"...","operatorId":"...","userMapping":{...}}}
    # See backend/app/services/tables/DATA_TABLE_CONFIG_EXAMPLE.md for details
    DATA_TABLE_CONFIG: str = ""

    # Knowledge base and document summary configuration
    # Enable/disable automatic summary generation after document indexing
    SUMMARY_ENABLED: bool = True

    # Long-term memory configuration (mem0)
    # Enable/disable long-term memory feature
    MEMORY_ENABLED: bool = False
    # mem0 service base URL
    MEMORY_BASE_URL: str = "http://localhost:8080"
    # Optional API key for mem0 service authentication
    MEMORY_API_KEY: str = ""
    # Search timeout in seconds (to avoid blocking chat flow)
    MEMORY_TIMEOUT_SECONDS: float = 2.0
    # Maximum number of memories to inject into system prompt
    MEMORY_MAX_RESULTS: int = 5
    # Number of recent messages to include as context when saving memory (default: 3 total)
    # This includes 2 history messages + 1 current message for better memory quality
    MEMORY_CONTEXT_MESSAGES: int = 3
    # User ID prefix for resource isolation in shared mem0 service
    # Since mem0 may be shared across multiple systems, this prefix ensures
    # wegent resources are isolated from other systems' resources
    MEMORY_USER_ID_PREFIX: str = "wegent_user:"

    # OpenTelemetry configuration is centralized in shared/telemetry/config.py
    # Use: from shared.telemetry.config import get_otel_config
    # All OTEL_* environment variables are read from there

    @classmethod
    def settings_customise_sources(
        cls,
        settings_cls: Type[BaseSettings],
        init_settings: PydanticBaseSettingsSource,
        env_settings: PydanticBaseSettingsSource,
        dotenv_settings: PydanticBaseSettingsSource,
        file_secret_settings: PydanticBaseSettingsSource,
    ) -> Tuple[PydanticBaseSettingsSource, ...]:
        """
        Customize settings sources to use NoInterpolationDotEnvSettingsSource.

        This ensures that template variables like ${{user.name}} in .env files
        are preserved and not incorrectly parsed by dotenv's interpolation.
        """
        return (
            init_settings,
            env_settings,
            NoInterpolationDotEnvSettingsSource(settings_cls),
            file_secret_settings,
        )

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )


# Global configuration instance
settings = Settings()
