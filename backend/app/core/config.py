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
    
    # Database configuration
    DATABASE_URL: str = "mysql+asyncmy://user:password@localhost/task_manager"

    # Executor configuration
    EXECUTOR_DELETE_TASK_URL: str = "http://localhost:8001/executor-manager/executor/delete"
    
    # JWT configuration
    SECRET_KEY: str = "secret-key"
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 24*60  # 24 hours in minutes

    # OIDC state configuration
    OIDC_STATE_SECRET_KEY: str = "test"
    OIDC_STATE_EXPIRE_SECONDS: int = 10*60  # 10 minutes, unit: seconds
    
    # Cache configuration
    REPO_CACHE_EXPIRED_TIME: int = 300  # 5 minutes in seconds

    # Task limits
    MAX_RUNNING_TASKS_PER_USER: int = 10

    # Task append expiration (hours)
    APPEND_TASK_EXPIRE_HOURS: int = 48

    # Subtask executor cleanup configuration
    # After a subtask is COMPLETED or FAILED, if executor_name/executor_namespace are set
    # and updated_at exceeds this threshold, the executor task will be deleted automatically.
    SUBTASK_EXECUTOR_DELETE_AFTER_HOURS: int = 48
    # Cleanup scanning interval seconds
    SUBTASK_CLEANUP_INTERVAL_SECONDS: int = 600

    # Frontend URL configuration
    FRONTEND_URL: str = "http://localhost:3000"

    # OIDC configuration
    OIDC_CLIENT_ID: str = "wegent"
    OIDC_CLIENT_SECRET: str = "test"
    OIDC_DISCOVERY_URL: str = "http://test.intra.weibo.com:5556/.well-known/openid-configuration"
    OIDC_REDIRECT_URI: str = "http://localhost:8000/api/auth/oidc/callback"

    # Redis configuration
    REDIS_URL: str = "redis://127.0.0.1:6379/0"

    # Team sharing configuration
    TEAM_SHARE_BASE_URL: str = "http://localhost:3000"
    TEAM_SHARE_QUERY_PARAM: str = "teamShare"
    
    # AES encryption configuration for share tokens
    SHARE_TOKEN_AES_KEY: str = "12345678901234567890123456789012"  # 32 bytes for AES-256
    SHARE_TOKEN_AES_IV: str = "1234567890123456"  # 16 bytes for AES IV

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"

# Global configuration instance
settings = Settings()