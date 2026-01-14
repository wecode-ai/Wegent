"""
Evaluation API endpoints.
"""

from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_db
from app.schemas.evaluation import (
    EvaluationAlertItem,
    EvaluationAlertsResponse,
    EvaluationResultDetail,
    EvaluationResultItem,
    EvaluationResultsResponse,
    EvaluationStatusResponse,
    EvaluationSummaryResponse,
    EvaluationTriggerRequest,
    EvaluationTriggerResponse,
    MetricDocumentation,
    MetricsDocumentationResponse,
)
from app.services.evaluation_service import EvaluationService
from app.services.metrics_docs import (
    get_all_metrics,
    get_metric_by_id,
)

router = APIRouter()


@router.post("/trigger", response_model=EvaluationTriggerResponse)
async def trigger_evaluation(
    request: EvaluationTriggerRequest,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
):
    """Trigger a new evaluation job."""
    service = EvaluationService(db)

    if request.mode == "range":
        if request.start_id is None or request.end_id is None:
            raise HTTPException(
                status_code=400,
                detail="start_id and end_id are required for range mode",
            )
        job_id, total = await service.trigger_evaluation(
            mode="range",
            start_id=request.start_id,
            end_id=request.end_id,
            force=request.force,
        )
    else:  # ids mode
        if not request.record_ids:
            raise HTTPException(
                status_code=400,
                detail="record_ids is required for ids mode",
            )
        job_id, total = await service.trigger_evaluation(
            mode="ids",
            record_ids=request.record_ids,
            force=request.force,
        )

    # Execute evaluation in background
    background_tasks.add_task(_run_evaluation, job_id)

    return EvaluationTriggerResponse(
        job_id=job_id,
        status="started",
        total_records=total,
    )


async def _run_evaluation(job_id: str):
    """Background task to run evaluation."""
    from app.core.database import AsyncSessionLocal

    async with AsyncSessionLocal() as db:
        service = EvaluationService(db)
        await service.execute_evaluation(job_id)


@router.get("/status/{job_id}", response_model=EvaluationStatusResponse)
async def get_evaluation_status(
    job_id: str,
    db: AsyncSession = Depends(get_db),
):
    """Get status of an evaluation job."""
    service = EvaluationService(db)
    job = service.get_job_status(job_id)

    if not job:
        raise HTTPException(status_code=404, detail="Evaluation job not found")

    return EvaluationStatusResponse(
        job_id=job_id,
        status=job["status"],
        total=job["total"],
        completed=job["completed"],
        failed=job["failed"],
        skipped=job["skipped"],
    )


@router.get("/results", response_model=EvaluationResultsResponse)
async def get_evaluation_results(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    start_date: Optional[datetime] = None,
    end_date: Optional[datetime] = None,
    has_issue: Optional[bool] = None,
    has_cv_alert: Optional[bool] = None,
    min_score: Optional[float] = Query(None, ge=0, le=1),
    max_score: Optional[float] = Query(None, ge=0, le=1),
    retriever_name: Optional[str] = None,
    embedding_model: Optional[str] = None,
    knowledge_id: Optional[int] = None,
    evaluation_status: Optional[str] = None,
    issue_type: Optional[str] = Query(None, description="Filter by issue type"),
    version_id: Optional[int] = Query(None, description="Filter by version ID"),
    db: AsyncSession = Depends(get_db),
):
    """Get evaluation results with filtering and pagination."""
    service = EvaluationService(db)
    items, total = await service.get_results(
        page=page,
        page_size=page_size,
        start_date=start_date,
        end_date=end_date,
        has_issue=has_issue,
        min_score=min_score,
        max_score=max_score,
        retriever_name=retriever_name,
        embedding_model=embedding_model,
        knowledge_id=knowledge_id,
        evaluation_status=evaluation_status,
        has_cv_alert=has_cv_alert,
        issue_type=issue_type,
        version_id=version_id,
    )

    total_pages = (total + page_size - 1) // page_size

    return EvaluationResultsResponse(
        items=[EvaluationResultItem(**item) for item in items],
        total=total,
        page=page,
        page_size=page_size,
        total_pages=total_pages,
    )


@router.get("/results/{result_id}", response_model=EvaluationResultDetail)
async def get_evaluation_result_detail(
    result_id: int,
    db: AsyncSession = Depends(get_db),
):
    """Get detailed evaluation result with all metrics."""
    service = EvaluationService(db)
    result = await service.get_result_detail(result_id)

    if not result:
        raise HTTPException(status_code=404, detail="Evaluation result not found")

    return EvaluationResultDetail(**result)


@router.get("/summary", response_model=EvaluationSummaryResponse)
async def get_evaluation_summary(
    start_date: Optional[datetime] = None,
    end_date: Optional[datetime] = None,
    version_id: Optional[int] = Query(None, description="Filter by version ID"),
    db: AsyncSession = Depends(get_db),
):
    """Get summary statistics for evaluation results."""
    service = EvaluationService(db)
    summary = await service.get_summary(
        start_date=start_date,
        end_date=end_date,
        version_id=version_id,
    )

    return EvaluationSummaryResponse(**summary)


@router.get("/alerts", response_model=EvaluationAlertsResponse)
async def get_evaluation_alerts(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    threshold: Optional[float] = Query(None, ge=0, le=1),
    version_id: Optional[int] = Query(None, description="Filter by version ID"),
    db: AsyncSession = Depends(get_db),
):
    """Get cross-validation alerts with pagination."""
    service = EvaluationService(db)
    items, total = await service.get_alerts(
        page=page,
        page_size=page_size,
        threshold=threshold,
        version_id=version_id,
    )

    total_pages = (total + page_size - 1) // page_size

    return EvaluationAlertsResponse(
        items=[EvaluationAlertItem(**item) for item in items],
        total=total,
        page=page,
        page_size=page_size,
        total_pages=total_pages,
    )


@router.get("/metrics-docs", response_model=MetricsDocumentationResponse)
async def get_metrics_documentation(
    framework: Optional[str] = Query(
        None, description="Filter by framework: ragas or trulens"
    ),
    signal_source: Optional[str] = Query(
        None, description="Filter by signal source: embedding or llm"
    ),
):
    """Get metrics documentation with optional filtering."""
    metrics = get_all_metrics()

    if framework:
        metrics = [m for m in metrics if m["framework"] == framework]

    if signal_source:
        metrics = [m for m in metrics if m["signal_source"] == signal_source]

    return MetricsDocumentationResponse(
        metrics=[MetricDocumentation(**m) for m in metrics],
        total=len(metrics),
    )


@router.get("/metrics-docs/{metric_id}", response_model=MetricDocumentation)
async def get_metric_documentation_by_id(metric_id: str):
    """Get single metric documentation by ID."""
    metric = get_metric_by_id(metric_id)

    if not metric:
        raise HTTPException(status_code=404, detail="Metric not found")

    return MetricDocumentation(**metric)
