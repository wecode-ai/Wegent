"""
Configuration endpoint for exposing non-sensitive settings to frontend.
"""
from fastapi import APIRouter
from pydantic import BaseModel

from app.core.config import settings

router = APIRouter()


class SyncConfigResponse(BaseModel):
    """Sync configuration response schema."""

    external_api_base_url: str
    sync_cron_expression: str


class EvaluationConfigResponse(BaseModel):
    """Evaluation configuration response schema."""

    ragas_llm_model: str
    ragas_embedding_model: str
    evaluation_cron_expression: str
    evaluation_batch_size: int


class SettingsConfigResponse(BaseModel):
    """Combined settings configuration response schema."""

    sync: SyncConfigResponse
    evaluation: EvaluationConfigResponse


@router.get("/config", response_model=SettingsConfigResponse)
async def get_settings_config():
    """
    Get application configuration for display in settings page.

    Returns non-sensitive configuration values that can be safely
    exposed to the frontend.
    """
    return SettingsConfigResponse(
        sync=SyncConfigResponse(
            external_api_base_url=settings.EXTERNAL_API_BASE_URL,
            sync_cron_expression=settings.SYNC_CRON_EXPRESSION,
        ),
        evaluation=EvaluationConfigResponse(
            ragas_llm_model=settings.RAGAS_LLM_MODEL,
            ragas_embedding_model=settings.RAGAS_EMBEDDING_MODEL,
            evaluation_cron_expression=settings.EVALUATION_CRON_EXPRESSION,
            evaluation_batch_size=settings.EVALUATION_BATCH_SIZE,
        ),
    )
