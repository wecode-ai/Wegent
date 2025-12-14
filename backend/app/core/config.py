# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from pydantic_settings import BaseSettings


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
    MAX_UPLOAD_FILE_SIZE_MB: int = 50  # Maximum file size in MB
    MAX_EXTRACTED_TEXT_LENGTH: int = 1000000  # Maximum extracted text length

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

    # Web search configuration
    WEB_SEARCH_ENABLED: bool = False  # Enable/disable web search feature
    WEB_SEARCH_ENGINES: str = "{}"  # JSON configuration for search API adapter

    # OpenTelemetry configuration is centralized in shared/telemetry/config.py
    # Use: from shared.telemetry.config import get_otel_config
    # All OTEL_* environment variables are read from there

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"
        extra = "ignore"


# Global configuration instance
settings = Settings()
