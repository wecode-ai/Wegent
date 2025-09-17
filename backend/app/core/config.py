# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    # Project configuration
    PROJECT_NAME: str = "Task Manager Backend"
    VERSION: str = "1.0.0"
    API_PREFIX: str = "/api"
    
    # Database configuration
    DATABASE_URL: str = "mysql+asyncmy://user:password@localhost/task_manager"

    # Executor configuration
    EXECUTOR_DELETE_TASK_URL: str = "http://localhost:8001/executor-manager/executor/delete"
    
    # JWT configuration
    SECRET_KEY: str = "secret-key"
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 30
    
    # Cache configuration
    REPO_CACHE_EXPIRED_TIME: int = 604800  # 7 days in seconds

    # Task limits
    MAX_RUNNING_TASKS_PER_USER: int = 10

    # Task append expiration (hours)
    APPEND_TASK_EXPIRE_HOURS: int = 48

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"

# Global configuration instance
settings = Settings()