# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Admin subscription monitor endpoints for background execution monitoring."""

from datetime import datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.security import get_admin_user
from app.models.kind import Kind
from app.models.subscription import BackgroundExecution
from app.models.user import User
from app.schemas.admin import (
    SubscriptionMonitorErrorListResponse,
    SubscriptionMonitorStats,
)
from app.schemas.subscription import BackgroundExecutionStatus

router = APIRouter()


@router.get("/subscription-monitor/stats", response_model=SubscriptionMonitorStats)
async def get_subscription_monitor_stats(
    hours: int = Query(default=24, ge=1, le=168, description="Time window in hours"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Get background execution statistics for admin monitoring.

    Returns execution counts and rates for the specified time window.
    """
    # Calculate time threshold
    time_threshold = datetime.utcnow() - timedelta(hours=hours)

    # Base query for executions in the time window
    base_query = db.query(BackgroundExecution).filter(
        BackgroundExecution.created_at >= time_threshold
    )

    # Total executions in time window
    total_executions = base_query.count()

    # Count by status
    completed_count = base_query.filter(
        BackgroundExecution.status == BackgroundExecutionStatus.COMPLETED.value
    ).count()
    failed_count = base_query.filter(
        BackgroundExecution.status == BackgroundExecutionStatus.FAILED.value
    ).count()
    cancelled_count = base_query.filter(
        BackgroundExecution.status == BackgroundExecutionStatus.CANCELLED.value
    ).count()
    running_count = base_query.filter(
        BackgroundExecution.status == BackgroundExecutionStatus.RUNNING.value
    ).count()
    pending_count = base_query.filter(
        BackgroundExecution.status == BackgroundExecutionStatus.PENDING.value
    ).count()
    retrying_count = base_query.filter(
        BackgroundExecution.status == BackgroundExecutionStatus.RETRYING.value
    ).count()

    # Calculate rates
    completed_executions = (
        completed_count + failed_count + cancelled_count + retrying_count
    )
    success_rate = (
        (completed_count / completed_executions * 100)
        if completed_executions > 0
        else 0.0
    )
    failure_rate = (
        (failed_count / completed_executions * 100) if completed_executions > 0 else 0.0
    )
    retrying_rate = (
        (retrying_count / completed_executions * 100)
        if completed_executions > 0
        else 0.0
    )

    # Count active subscriptions (with active schedules)
    total_subscriptions = db.query(Kind).filter(Kind.kind == "Subscription").count()

    # Count subscriptions with running or pending executions as "active"
    active_subscription_ids = (
        db.query(BackgroundExecution.subscription_id)
        .filter(
            BackgroundExecution.status.in_(
                [
                    BackgroundExecutionStatus.RUNNING.value,
                    BackgroundExecutionStatus.PENDING.value,
                ]
            )
        )
        .distinct()
        .count()
    )

    return SubscriptionMonitorStats(
        total_executions=total_executions,
        completed_count=completed_count,
        failed_count=failed_count,
        retrying_count=retrying_count,
        cancelled_count=cancelled_count,
        running_count=running_count,
        pending_count=pending_count,
        success_rate=round(success_rate, 2),
        failure_rate=round(failure_rate, 2),
        retrying_rate=round(retrying_rate, 2),
        active_subscriptions_count=active_subscription_ids,
        total_subscriptions_count=total_subscriptions,
    )


@router.get(
    "/subscription-monitor/errors", response_model=SubscriptionMonitorErrorListResponse
)
async def get_subscription_monitor_errors(
    page: int = Query(default=1, ge=1, description="Page number"),
    limit: int = Query(default=20, ge=1, le=100, description="Items per page"),
    hours: int = Query(default=24, ge=1, le=168, description="Time window in hours"),
    status: Optional[str] = Query(default=None, description="Filter by status"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Get background execution errors for admin monitoring.

    Returns a paginated list of error records from the specified time window.
    Only includes executions with terminal error states (FAILED, CANCELLED).
    """
    # Calculate time threshold
    time_threshold = datetime.utcnow() - timedelta(hours=hours)

    # Base query
    query = db.query(BackgroundExecution).filter(
        BackgroundExecution.created_at >= time_threshold
    )

    # Filter by error statuses
    error_statuses = [
        BackgroundExecutionStatus.FAILED.value,
        BackgroundExecutionStatus.CANCELLED.value,
    ]

    if status:
        # If specific status provided, filter by it
        query = query.filter(BackgroundExecution.status == status.upper())
    else:
        # Default: show all error statuses
        query = query.filter(BackgroundExecution.status.in_(error_statuses))

    # Get total count
    total = query.count()

    # Get paginated results
    executions = (
        query.order_by(BackgroundExecution.created_at.desc())
        .offset((page - 1) * limit)
        .limit(limit)
        .all()
    )

    # Build response items
    items = []
    for exec in executions:
        items.append(
            {
                "execution_id": exec.id,
                "subscription_id": exec.subscription_id,
                "user_id": exec.user_id,
                "task_id": exec.task_id if exec.task_id > 0 else None,
                "status": exec.status,
                "error_message": exec.error_message if exec.error_message else None,
                "trigger_type": exec.trigger_type,
                "created_at": exec.created_at,
                "started_at": exec.started_at,
                "completed_at": exec.completed_at,
            }
        )

    return SubscriptionMonitorErrorListResponse(
        total=total,
        items=items,
    )
