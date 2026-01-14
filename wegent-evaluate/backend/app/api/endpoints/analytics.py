"""
Analytics API endpoints.
"""
from datetime import datetime
from typing import Literal, Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_db
from app.schemas.analytics import (
    ContextComparisonResponse,
    EmbeddingComparisonResponse,
    IssuesAnalyticsResponse,
    RetrieverComparisonResponse,
    TrendsResponse,
)
from app.services.analytics_service import AnalyticsService

router = APIRouter()


@router.get("/trends", response_model=TrendsResponse)
async def get_trends(
    start_date: datetime,
    end_date: datetime,
    metric: Literal[
        "faithfulness", "answer_relevancy", "context_precision", "overall"
    ] = "overall",
    group_by: Literal["day", "week", "month"] = "day",
    retriever_name: Optional[str] = None,
    embedding_model: Optional[str] = None,
    version_id: Optional[int] = Query(None, description="Filter by version ID"),
    db: AsyncSession = Depends(get_db),
):
    """Get trend data for a specific metric over time."""
    service = AnalyticsService(db)
    data = await service.get_trends(
        start_date=start_date,
        end_date=end_date,
        metric=metric,
        group_by=group_by,
        retriever_name=retriever_name,
        embedding_model=embedding_model,
        version_id=version_id,
    )

    return TrendsResponse(
        metric=metric,
        group_by=group_by,
        data=data,
    )


@router.get("/comparison/retriever", response_model=RetrieverComparisonResponse)
async def get_retriever_comparison(
    start_date: datetime,
    end_date: datetime,
    version_id: Optional[int] = Query(None, description="Filter by version ID"),
    db: AsyncSession = Depends(get_db),
):
    """Compare evaluation metrics across different retrievers."""
    service = AnalyticsService(db)
    data = await service.get_retriever_comparison(
        start_date=start_date,
        end_date=end_date,
        version_id=version_id,
    )

    return RetrieverComparisonResponse(data=data)


@router.get("/comparison/embedding", response_model=EmbeddingComparisonResponse)
async def get_embedding_comparison(
    start_date: datetime,
    end_date: datetime,
    version_id: Optional[int] = Query(None, description="Filter by version ID"),
    db: AsyncSession = Depends(get_db),
):
    """Compare evaluation metrics across different embedding models."""
    service = AnalyticsService(db)
    data = await service.get_embedding_comparison(
        start_date=start_date,
        end_date=end_date,
        version_id=version_id,
    )

    return EmbeddingComparisonResponse(data=data)


@router.get("/comparison/context/{subtask_context_id}", response_model=ContextComparisonResponse)
async def get_context_comparison(
    subtask_context_id: int,
    db: AsyncSession = Depends(get_db),
):
    """Get comparison of all evaluations for a specific context."""
    service = AnalyticsService(db)
    data = await service.get_context_comparison(subtask_context_id=subtask_context_id)

    return ContextComparisonResponse(**data)


@router.get("/issues", response_model=IssuesAnalyticsResponse)
async def get_issues_analytics(
    start_date: datetime,
    end_date: datetime,
    version_id: Optional[int] = Query(None, description="Filter by version ID"),
    db: AsyncSession = Depends(get_db),
):
    """Get analytics on issue types."""
    service = AnalyticsService(db)
    data = await service.get_issues_analytics(
        start_date=start_date,
        end_date=end_date,
        version_id=version_id,
    )

    return IssuesAnalyticsResponse(**data)
