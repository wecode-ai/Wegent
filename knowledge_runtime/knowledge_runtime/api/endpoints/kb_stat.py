# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""KB stat HTTP endpoints for knowledge_runtime."""

from __future__ import annotations

import logging
from datetime import date, datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException

from knowledge_engine.stat.filters import MetricFilter
from shared.models.kb_stat import (
    CollectorRunInfo,
    CollectorRunListResponse,
    DashboardResponse,
    HealthResponse,
    KbStatFilter,
    MetricBatchRequest,
    MetricBatchResponse,
    MetricListResponse,
    MetricResponse,
    QualityAlertMetricsResponse,
    RunInfo,
    RunListResponse,
    TriggerRunRequest,
    TriggerRunResponse,
)

logger = logging.getLogger(__name__)

# /health is intentionally outside this gate — it must stay reachable for
# monitoring even when the feature is disabled, so operators can confirm
# the switch state and DB connectivity from one place.
router = APIRouter()
_gated_router = APIRouter()


def _get_query_service():
    from knowledge_runtime.services.kb_stat_query import get_query_service

    return get_query_service()


def require_kb_stat_enabled() -> None:
    """503 when the KB-stat master switch is off.

    Mounted on the gated sub-router so /health stays exempt.
    """
    from knowledge_runtime.config import get_settings

    if not get_settings().kb_stat_enabled:
        raise HTTPException(
            status_code=503,
            detail={
                "code": "kb_stat_disabled",
                "message": "KB statistics feature is disabled",
                "retryable": False,
            },
        )


def _to_metric_filter(payload: KbStatFilter) -> MetricFilter:
    target_date = payload.end_date or date.today()
    return MetricFilter(
        target_date=target_date,
        kb_ids=list(payload.kb_ids) if payload.kb_ids else None,
        namespaces=list(payload.namespaces) if payload.namespaces else None,
        period_start_date=payload.start_date,
        end_date=payload.end_date,
        run_id=payload.run_id,
    )


@router.get("/health", response_model=HealthResponse)
async def health_check():
    svc = _get_query_service()
    data = svc.health()
    if not data.get("stat_db_ok"):
        raise HTTPException(status_code=503, detail=data)
    return HealthResponse(**data)


@_gated_router.post("/dashboard", response_model=DashboardResponse)
async def dashboard(payload: KbStatFilter):
    mfilter = _to_metric_filter(payload)
    result = _get_query_service().fetch_dashboard(mfilter)
    return DashboardResponse(**result)


@_gated_router.post("/metrics/batch", response_model=MetricBatchResponse)
async def metric_batch(payload: MetricBatchRequest):
    """Fetch many metrics in one HTTP round-trip.

    The frontend stat page renders dozens of metric cards; without a batch
    endpoint each card would fire its own request through backend → runtime
    → DB. Here we resolve the latest run once and loop the metrics inside a
    single session, cutting N requests down to one.

    Declared before the {name} route so "batch" matches this literal path
    instead of being captured as a metric name.
    """
    mfilter = _to_metric_filter(payload)
    result = _get_query_service().fetch_metrics_batch(payload.names, mfilter)
    return MetricBatchResponse(**result)


@_gated_router.post("/metrics/{name}", response_model=MetricResponse)
async def metric(name: str, payload: KbStatFilter):
    mfilter = _to_metric_filter(payload)
    try:
        result = _get_query_service().fetch_metric(name, mfilter)
    except KeyError:
        raise HTTPException(404, f"unknown metric: {name}")
    return MetricResponse(**result)


@_gated_router.post(
    "/quality-alert-metrics",
    response_model=QualityAlertMetricsResponse,
)
async def quality_alert_metrics(payload: KbStatFilter):
    """Return untruncated rows for platform alert evaluation."""
    mfilter = _to_metric_filter(payload)
    return QualityAlertMetricsResponse(
        **_get_query_service().fetch_quality_alert_metrics(mfilter)
    )


@_gated_router.get("/metrics/list", response_model=MetricListResponse)
async def list_metrics(scope: str = "admin"):
    data = _get_query_service().list_metrics(scope=scope)
    return MetricListResponse(domains=data)


@_gated_router.get("/runs", response_model=RunListResponse)
async def list_runs(
    limit: int = 20,
    offset: int = 0,
    status: Optional[str] = None,
    target_date_start: Optional[str] = None,
    target_date_end: Optional[str] = None,
):
    data = _get_query_service().list_runs(
        limit=limit,
        offset=offset,
        status=status,
        target_date_start=target_date_start,
        target_date_end=target_date_end,
    )
    return RunListResponse(
        runs=[RunInfo(**r) for r in data["runs"]],
        total=data["total"],
    )


@_gated_router.get("/runs/{run_id}/collectors", response_model=CollectorRunListResponse)
async def list_collector_runs(run_id: int):
    data = _get_query_service().get_collector_runs(run_id)
    return CollectorRunListResponse(
        run_id=run_id,
        collectors=[CollectorRunInfo(**c) for c in data],
    )


@_gated_router.get("/runs/{run_id}", response_model=RunInfo)
async def get_run(run_id: int):
    data = _get_query_service().get_run(run_id)
    if data is None:
        raise HTTPException(404, f"run {run_id} not found")
    return RunInfo(**data)


@_gated_router.post("/runs/trigger", response_model=TriggerRunResponse)
async def trigger_run(payload: TriggerRunRequest):
    from fastapi.responses import JSONResponse
    from knowledge_runtime.config import get_settings
    from knowledge_runtime.tasks.stat_tasks import (
        _find_running_run,
        collect_all_metrics_task,
    )

    try:
        target = payload.target_date or datetime.now(timezone.utc).date()

        # Fast-path: reject re-triggers for a date already running. The
        # authoritative mutual-exclusion lives in the Celery task (Redis
        # SET NX EX lock); this DB check only avoids enqueuing work that
        # would immediately contend. The 409 body is shaped as
        # RemoteRagError so the backend can parse code/details verbatim.
        existing = _find_running_run(target)
        if existing is not None:
            return JSONResponse(
                status_code=409,
                content={
                    "code": "run_in_progress",
                    "message": f"a kb_stat run is already in progress for {target}",
                    "retryable": False,
                    "details": {
                        "existing_run_id": existing,
                        "target_date": target.isoformat(),
                    },
                },
            )

        result = collect_all_metrics_task.delay(
            target_date_iso=target.isoformat(),
            kb_ids=payload.kb_ids,
            domains=payload.domains,
            collector_names=payload.collector_names,
            triggered_by=payload.triggered_by,
            triggered_user_id=payload.triggered_user_id,
            lookback_days=get_settings().knowledge_stat_lookback_days,
        )
        return TriggerRunResponse(celery_task_id=result.id)
    except Exception as e:
        logger.error(f"[kb_stat] failed to trigger run: {e}")
        raise HTTPException(500, f"failed to trigger run: {e}")


# Attach the gated routes under the master switch dependency. /health on
# the base router stays accessible regardless of the switch state.
router.include_router(
    _gated_router,
    dependencies=[Depends(require_kb_stat_enabled)],
)
