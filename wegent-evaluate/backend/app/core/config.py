"""
Configuration management for Wegent Evaluate.
"""

from pathlib import Path
from typing import Optional

from pydantic_settings import BaseSettings, SettingsConfigDict


# Get the project root directory (parent of backend/)
_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent
_ENV_FILE = _PROJECT_ROOT / ".env"


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    # Project configuration
    PROJECT_NAME: str = "Wegent Evaluate"
    VERSION: str = "1.0.0"
    API_PREFIX: str = "/api"
    ENVIRONMENT: str = "development"

    # Database configuration
    DATABASE_URL: str = "mysql+asyncmy://user:password@localhost:13306/wegent_evaluate"

    # External API configuration
    EXTERNAL_API_BASE_URL: str = "http://localhost:18000"
    EXTERNAL_API_QA_HISTORY_PATH: str = "/api/v1/knowledge-base/qa-history"

    # External API authentication configuration
    EXTERNAL_API_LOGIN_PATH: str = "/api/auth/login"
    EXTERNAL_API_USERNAME: str = "admin"
    EXTERNAL_API_PASSWORD: str = "Wegent2025!"

    # RAGAS LLM configuration
    RAGAS_LLM_MODEL: str = "gpt-4"
    RAGAS_LLM_API_KEY: str = "your_openai_api_key"
    RAGAS_LLM_BASE_URL: str = "https://api.openai.com/v1"

    # RAGAS Embedding configuration
    RAGAS_EMBEDDING_MODEL: str = "text-embedding-3-small"
    RAGAS_EMBEDDING_API_KEY: str = "your_openai_api_key"
    RAGAS_EMBEDDING_BASE_URL: str = "https://api.openai.com/v1"

    # Analysis LLM configuration
    ANALYSIS_LLM_MODEL: str = "gpt-4"
    ANALYSIS_LLM_API_KEY: str = "your_openai_api_key"
    ANALYSIS_LLM_BASE_URL: str = "https://api.openai.com/v1"
    ANALYSIS_LANGUAGE: str = "zh"  # Language for LLM analysis output: "zh" (Chinese) or "en" (English)

    # Scheduled task configuration
    SYNC_CRON_EXPRESSION: str = "0 2 * * *"  # Daily at 2 AM
    EVALUATION_CRON_EXPRESSION: str = "0 4 * * *"  # Daily at 4 AM

    # Evaluation batch configuration
    EVALUATION_BATCH_SIZE: int = 10
    EVALUATION_CONCURRENCY: int = 1

    # Frontend URL for CORS
    FRONTEND_URL: str = "http://localhost:13000"

    # Excluded User IDs for filtering (comma-separated list)
    EXCLUDED_USER_IDS: str = ""

    @property
    def excluded_user_ids_list(self) -> list:
        """Parse EXCLUDED_USER_IDS into a list of integers."""
        if not self.EXCLUDED_USER_IDS or not self.EXCLUDED_USER_IDS.strip():
            return []
        try:
            return [
                int(uid.strip())
                for uid in self.EXCLUDED_USER_IDS.split(",")
                if uid.strip()
            ]
        except ValueError:
            return []

    model_config = SettingsConfigDict(
        env_file=str(_ENV_FILE) if _ENV_FILE.exists() else ".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )


settings = Settings()

