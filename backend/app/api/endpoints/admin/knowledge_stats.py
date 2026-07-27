# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Admin endpoints for KB statistics (admin-only access)."""

from __future__ import annotations

import logging
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.security import get_admin_user, get_current_user
from app.models.user import User
from app.services.kb_stat import get_kb_stat_gateway
from app.services.kb_stat.dependencies import require_kb_stat_enabled
from app.services.runtime_client import RemoteRuntimeError
from shared.models.kb_stat import (
    CollectorRunListResponse,
    DashboardResponse,
    KbStatFilter,
    MetricBatchRequest,
    MetricBatchResponse,
    MetricListResponse,
    MetricResponse,
    RunListResponse,
    TriggerRunRequest,
    TriggerRunResponse,
)

logger = logging.getLogger(__name__)

router = APIRouter(dependencies=[Depends(require_kb_stat_enabled)])


@router.post("/knowledge-stats/dashboard", response_model=DashboardResponse)
async def admin_dashboard(
    payload: KbStatFilter,
    current_user: User = Depends(get_admin_user),
):
    gateway = get_kb_stat_gateway()
    try:
        return await gateway.dashboard(payload)
    except RemoteRuntimeError as e:
        _handle_remote_error(e)


@router.post("/knowledge-stats/metrics/batch", response_model=MetricBatchResponse)
async def admin_metric_batch(
    payload: MetricBatchRequest,
    current_user: User = Depends(get_admin_user),
):
    """Batch-fetch many metrics in one request (admin scope, no kb filter).

    Mirrors the per-metric endpoint but resolves the latest run once and
    loops names server-side, collapsing dozens of per-card requests into
    one HTTP round-trip. Declared before the {name} route so "batch"
    matches this literal path instead of being captured as a metric name.
    """
    gateway = get_kb_stat_gateway()
    try:
        return await gateway.metric_batch(payload)
    except RemoteRuntimeError as e:
        _handle_remote_error(e)


@router.post("/knowledge-stats/metrics/{name}", response_model=MetricResponse)
async def admin_metric(
    name: str,
    payload: KbStatFilter,
    current_user: User = Depends(get_admin_user),
):
    gateway = get_kb_stat_gateway()
    try:
        return await gateway.metric(name, payload)
    except RemoteRuntimeError as e:
        if e.status_code == 404:
            raise HTTPException(404, f"unknown metric: {name}")
        _handle_remote_error(e)


@router.get("/knowledge-stats/metrics/list", response_model=MetricListResponse)
async def admin_list_metrics(
    current_user: User = Depends(get_admin_user),
):
    gateway = get_kb_stat_gateway()
    try:
        return await gateway.list_metrics()
    except RemoteRuntimeError as e:
        _handle_remote_error(e)


@router.get("/knowledge-stats/runs", response_model=RunListResponse)
async def admin_list_runs(
    limit: int = 20,
    offset: int = 0,
    status: Optional[str] = None,
    target_date_start: Optional[str] = None,
    target_date_end: Optional[str] = None,
    current_user: User = Depends(get_admin_user),
):
    gateway = get_kb_stat_gateway()
    try:
        return await gateway.list_runs(
            limit=limit,
            offset=offset,
            status=status,
            target_date_start=target_date_start,
            target_date_end=target_date_end,
        )
    except RemoteRuntimeError as e:
        _handle_remote_error(e)


@router.get(
    "/knowledge-stats/runs/{run_id}/collectors",
    response_model=CollectorRunListResponse,
)
async def admin_list_collector_runs(
    run_id: int,
    current_user: User = Depends(get_admin_user),
):
    gateway = get_kb_stat_gateway()
    try:
        return await gateway.list_collector_runs(run_id)
    except RemoteRuntimeError as e:
        _handle_remote_error(e)


@router.post("/knowledge-stats/runs/trigger", response_model=TriggerRunResponse)
async def admin_trigger_run(
    payload: TriggerRunRequest,
    current_user: User = Depends(get_admin_user),
):
    gateway = get_kb_stat_gateway()
    runtime_payload = TriggerRunRequest(
        target_date=payload.target_date,
        kb_ids=payload.kb_ids,
        domains=payload.domains,
        triggered_by="manual_api",
        triggered_user_id=current_user.id,
    )
    try:
        return await gateway.trigger_run(runtime_payload)
    except RemoteRuntimeError as e:
        _handle_remote_error(e)


@router.post("/knowledge-stats/runs/{run_id}/retry", response_model=TriggerRunResponse)
async def admin_retry_run(
    run_id: int,
    current_user: User = Depends(get_admin_user),
):
    gateway = get_kb_stat_gateway()
    try:
        collector_data = await gateway.list_collector_runs(run_id)
        failed_collectors = [
            c
            for c in collector_data.get("collectors", [])
            if c.get("status") == "failed"
        ]
        failed_domains = list({c["domain"] for c in failed_collectors})

        run_info = None
        runs_data = await gateway.list_runs(limit=200)
        for r in runs_data.get("runs", []):
            if r.get("id") == run_id:
                run_info = r
                break

        target_date = None
        kb_ids = None
        if run_info:
            import json
            from datetime import date as date_type

            td = run_info.get("target_date")
            if td:
                target_date = date_type.fromisoformat(td)
            kf = run_info.get("kb_filter")
            if kf:
                try:
                    kb_ids = json.loads(kf)
                except (json.JSONDecodeError, TypeError):
                    kb_ids = None

        runtime_payload = TriggerRunRequest(
            target_date=target_date,
            kb_ids=kb_ids,
            domains=failed_domains if failed_domains else None,
            triggered_by="retry",
            triggered_user_id=current_user.id,
        )
        return await gateway.trigger_run(runtime_payload)
    except RemoteRuntimeError as e:
        _handle_remote_error(e)


def _handle_remote_error(e: RemoteRuntimeError) -> None:
    if e.retryable:
        raise HTTPException(502, {"code": "remote_transport_error", "message": str(e)})
    if e.status_code == 409:
        # Preserve structured detail (e.g. run_in_progress existing_run_id).
        raise HTTPException(409, e.details or str(e))
    if e.status_code:
        raise HTTPException(e.status_code, e.details or str(e))
    raise HTTPException(502, str(e))
