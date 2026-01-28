# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
API endpoints for Subscription (订阅) module.

This module provides REST API endpoints for managing Subscription configurations
and their background executions.
"""
import hashlib
import hmac
import logging
from datetime import datetime
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.models.user import User
from app.schemas.subscription import (
    BackgroundExecutionInDB,
    BackgroundExecutionListResponse,
    BackgroundExecutionStatus,
    DiscoverSubscriptionsListResponse,
    SubscriptionCreate,
    SubscriptionInDB,
    SubscriptionListResponse,
    SubscriptionTriggerType,
    SubscriptionUpdate,
)
from app.services.subscription import subscription_service
from app.services.subscription.follow_service import subscription_follow_service

logger = logging.getLogger(__name__)

router = APIRouter()


# ========== Subscription Configuration Endpoints ==========


@router.get("", response_model=SubscriptionListResponse)
def list_subscriptions(
    page: int = Query(1, ge=1, description="Page number"),
    limit: int = Query(20, ge=1, le=100, description="Items per page"),
    enabled: Optional[bool] = Query(None, description="Filter by enabled status"),
    trigger_type: Optional[SubscriptionTriggerType] = Query(
        None, description="Filter by trigger type"
    ),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    List current user's Subscription configurations.

    Returns paginated list of Subscriptions with support for filtering by enabled status
    and trigger type.
    """
    skip = (page - 1) * limit

    items, total = subscription_service.list_subscriptions(
        db=db,
        user_id=current_user.id,
        skip=skip,
        limit=limit,
        enabled=enabled,
        trigger_type=trigger_type,
    )

    return SubscriptionListResponse(total=total, items=items)


@router.post("", response_model=SubscriptionInDB, status_code=status.HTTP_201_CREATED)
def create_subscription(
    subscription_in: SubscriptionCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Create a new Subscription configuration.

    The Subscription will be created with the specified trigger configuration and
    associated with the given Team (Agent).
    """
    return subscription_service.create_subscription(
        db=db,
        subscription_in=subscription_in,
        user_id=current_user.id,
    )


# ========== Discover Endpoint ==========
# NOTE: This static route MUST be defined before /{subscription_id} dynamic routes


@router.get("/discover", response_model=DiscoverSubscriptionsListResponse)
def discover_subscriptions(
    sort_by: str = Query("popularity", description="Sort by: 'popularity' or 'recent'"),
    search: Optional[str] = Query(None, description="Search query"),
    page: int = Query(1, ge=1, description="Page number"),
    limit: int = Query(50, ge=1, le=100, description="Items per page"),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Discover public subscriptions.

    Returns a list of public subscriptions that can be followed.
    Can be sorted by popularity (follower count) or recency.
    """
    skip = (page - 1) * limit
    return subscription_follow_service.discover_subscriptions(
        db=db,
        user_id=current_user.id,
        sort_by=sort_by,
        search=search,
        skip=skip,
        limit=limit,
    )


# ========== Execution History Endpoints (Timeline) ==========
# NOTE: These static routes MUST be defined before /{subscription_id} dynamic routes


@router.get("/executions", response_model=BackgroundExecutionListResponse)
def list_executions(
    page: int = Query(1, ge=1, description="Page number"),
    limit: int = Query(50, ge=1, le=100, description="Items per page"),
    subscription_id: Optional[int] = Query(
        None, description="Filter by subscription ID"
    ),
    status: Optional[List[BackgroundExecutionStatus]] = Query(
        None, description="Filter by execution status"
    ),
    start_date: Optional[datetime] = Query(None, description="Filter by start date"),
    end_date: Optional[datetime] = Query(None, description="Filter by end date"),
    include_silent: bool = Query(
        False, description="Include silent executions (COMPLETED_SILENT)"
    ),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    List background execution history (timeline view).

    Returns paginated list of execution records sorted by creation time (newest first).
    Supports filtering by subscription, status, and date range.

    By default, silent executions (COMPLETED_SILENT) are excluded. Set include_silent=True
    to include them in the results.
    """
    skip = (page - 1) * limit

    items, total = subscription_service.list_executions(
        db=db,
        user_id=current_user.id,
        skip=skip,
        limit=limit,
        subscription_id=subscription_id,
        status=status,
        start_date=start_date,
        end_date=end_date,
        include_silent=include_silent,
    )

    return BackgroundExecutionListResponse(total=total, items=items)


@router.get("/executions/stale", response_model=List[BackgroundExecutionInDB])
def get_stale_executions(
    hours: int = Query(default=1, ge=1, le=24, description="Hours threshold"),
    execution_status: Optional[str] = Query(
        default="RUNNING",
        alias="status",
        description="Filter by status (PENDING, RUNNING, etc.)",
    ),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Get stale executions for debugging purposes.

    Returns executions that have been in the specified status for longer than
    the given hours threshold. Useful for identifying stuck executions.

    Args:
        hours: Number of hours to consider as stale (1-24)
        status: Execution status to filter by (default: RUNNING)
    """
    from datetime import timedelta

    from app.models.kind import Kind
    from app.models.subscription import BackgroundExecution
    from app.schemas.subscription import Subscription

    # Calculate threshold
    threshold = datetime.utcnow() - timedelta(hours=hours)

    # Build query - only show user's own executions
    query = db.query(BackgroundExecution).filter(
        BackgroundExecution.user_id == current_user.id,
        BackgroundExecution.created_at < threshold,
    )

    # Filter by status if provided
    if execution_status:
        query = query.filter(BackgroundExecution.status == execution_status)

    executions = query.order_by(BackgroundExecution.created_at.desc()).limit(50).all()

    # Convert to BackgroundExecutionInDB
    result = []
    for exec in executions:
        exec_dict = {
            "id": exec.id,
            "user_id": exec.user_id,
            "subscription_id": exec.subscription_id,
            "task_id": exec.task_id,
            "trigger_type": exec.trigger_type,
            "trigger_reason": exec.trigger_reason,
            "prompt": exec.prompt,
            "status": BackgroundExecutionStatus(exec.status),
            "result_summary": exec.result_summary,
            "error_message": exec.error_message,
            "retry_attempt": exec.retry_attempt,
            "started_at": exec.started_at,
            "completed_at": exec.completed_at,
            "created_at": exec.created_at,
            "updated_at": exec.updated_at,
        }

        # Get subscription details
        subscription = (
            db.query(Kind)
            .filter(
                Kind.id == exec.subscription_id,
                Kind.kind == "Subscription",
            )
            .first()
        )
        if subscription:
            subscription_crd = Subscription.model_validate(subscription.json)
            internal = subscription.json.get("_internal", {})
            exec_dict["subscription_name"] = subscription.name
            exec_dict["subscription_display_name"] = subscription_crd.spec.displayName
            exec_dict["task_type"] = subscription_crd.spec.taskType.value

            team_id = internal.get("team_id")
            if team_id:
                team = db.query(Kind).filter(Kind.id == team_id).first()
                if team:
                    exec_dict["team_name"] = team.name

        result.append(BackgroundExecutionInDB(**exec_dict))

    return result


@router.get("/executions/{execution_id}", response_model=BackgroundExecutionInDB)
def get_execution(
    execution_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Get a specific background execution by ID.

    Returns detailed information about the execution including the resolved prompt
    and any result/error messages.
    """
    return subscription_service.get_execution(
        db=db,
        execution_id=execution_id,
        user_id=current_user.id,
    )


@router.post(
    "/executions/{execution_id}/cancel", response_model=BackgroundExecutionInDB
)
def cancel_execution(
    execution_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Cancel a running or pending background execution.

    This endpoint allows users to manually stop an execution that is in PENDING
    or RUNNING state. Executions in terminal states (COMPLETED, FAILED, CANCELLED)
    cannot be cancelled.

    Returns the updated execution record with CANCELLED status.
    """
    return subscription_service.cancel_execution(
        db=db,
        execution_id=execution_id,
        user_id=current_user.id,
    )


@router.delete("/executions/{execution_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_execution(
    execution_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Delete a background execution record.

    This endpoint allows users to delete an execution record from the timeline.
    Only executions in terminal states (COMPLETED, FAILED, CANCELLED) can be deleted.
    Running or pending executions must be cancelled first.
    """
    subscription_service.delete_execution(
        db=db,
        execution_id=execution_id,
        user_id=current_user.id,
    )


# ========== Webhook Trigger Endpoint ==========


@router.post("/webhook/{webhook_token}", response_model=BackgroundExecutionInDB)
async def trigger_subscription_webhook(
    webhook_token: str,
    request: Request,
    x_webhook_signature: Optional[str] = Header(None, alias="X-Webhook-Signature"),
    db: Session = Depends(get_db),
):
    """
    Trigger a Subscription via webhook.

    This endpoint is called by external systems to trigger event-based subscriptions.
    The payload will be available as {{webhook_data}} in the prompt template.

    If the Subscription has a webhook_secret configured, the request must include
    a valid HMAC-SHA256 signature in the X-Webhook-Signature header.

    Signature format: sha256=<hex_digest>

    To generate the signature:
    1. Get the raw request body
    2. Compute HMAC-SHA256 using the webhook secret
    3. Set header: X-Webhook-Signature: sha256=<hex_digest>
    """
    # Get the subscription first to check if signature verification is required
    subscription = subscription_service.get_subscription_by_webhook_token(
        db, webhook_token=webhook_token
    )
    if not subscription:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Subscription not found or disabled",
        )

    # Get internal data for webhook secret
    internal = subscription.json.get("_internal", {})
    webhook_secret = internal.get("webhook_secret")

    # Read the raw body for signature verification
    body = await request.body()

    # Verify signature if the subscription has a secret configured
    if webhook_secret:
        if not x_webhook_signature:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Missing X-Webhook-Signature header",
            )

        # Parse signature (format: sha256=<hex_digest>)
        if not x_webhook_signature.startswith("sha256="):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid signature format. Expected: sha256=<hex_digest>",
            )

        provided_signature = x_webhook_signature[7:]  # Remove "sha256=" prefix

        # Compute expected signature
        expected_signature = hmac.new(
            webhook_secret.encode("utf-8"),
            body,
            hashlib.sha256,
        ).hexdigest()

        # Constant-time comparison to prevent timing attacks
        if not hmac.compare_digest(provided_signature, expected_signature):
            logger.warning(
                f"[webhook] Invalid signature for subscription {subscription.id}, "
                f"token={webhook_token[:8]}..."
            )
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid signature",
            )

    # Parse the payload
    payload: Dict[str, Any] = {}
    if body:
        try:
            import json

            payload = json.loads(body)
        except json.JSONDecodeError:
            # If not valid JSON, treat as empty payload
            pass

    return subscription_service.trigger_subscription_by_webhook(
        db=db,
        webhook_token=webhook_token,
        payload=payload,
    )


# ========== Subscription CRUD with Dynamic ID ==========
# NOTE: Dynamic routes MUST come after static routes like /executions


@router.get("/{subscription_id}", response_model=SubscriptionInDB)
def get_subscription(
    subscription_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Get a specific Subscription configuration by ID.
    """
    return subscription_service.get_subscription(
        db=db,
        subscription_id=subscription_id,
        user_id=current_user.id,
    )


@router.put("/{subscription_id}", response_model=SubscriptionInDB)
def update_subscription(
    subscription_id: int,
    subscription_in: SubscriptionUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Update an existing Subscription configuration.

    Any fields not provided will retain their current values.
    """
    return subscription_service.update_subscription(
        db=db,
        subscription_id=subscription_id,
        subscription_in=subscription_in,
        user_id=current_user.id,
    )


@router.delete("/{subscription_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_subscription(
    subscription_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Delete a Subscription configuration (soft delete).

    The Subscription will be marked as inactive and disabled.
    """
    subscription_service.delete_subscription(
        db=db,
        subscription_id=subscription_id,
        user_id=current_user.id,
    )


@router.post("/{subscription_id}/toggle", response_model=SubscriptionInDB)
def toggle_subscription(
    subscription_id: int,
    enabled: bool = Query(..., description="Enable or disable the subscription"),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Enable or disable a Subscription.

    When enabled, scheduled subscriptions will resume executing according to their
    trigger configuration. When disabled, no new executions will be triggered.
    """
    return subscription_service.toggle_subscription(
        db=db,
        subscription_id=subscription_id,
        user_id=current_user.id,
        enabled=enabled,
    )


@router.post("/{subscription_id}/trigger", response_model=BackgroundExecutionInDB)
def trigger_subscription(
    subscription_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Manually trigger a Subscription execution.

    Creates a new execution record and queues the task for immediate execution.
    This is useful for testing subscriptions or running them outside their normal schedule.
    """
    return subscription_service.trigger_subscription_manually(
        db=db,
        subscription_id=subscription_id,
        user_id=current_user.id,
    )
