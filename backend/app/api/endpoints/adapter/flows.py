# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
API endpoints for AI Flow (智能流) module.
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
from app.schemas.flow import (
    FlowCreate,
    FlowExecutionInDB,
    FlowExecutionListResponse,
    FlowExecutionStatus,
    FlowInDB,
    FlowListResponse,
    FlowTriggerType,
    FlowUpdate,
)
from app.services.flow import flow_service

logger = logging.getLogger(__name__)

router = APIRouter()


# ========== Flow Configuration Endpoints ==========


@router.get("", response_model=FlowListResponse)
def list_flows(
    page: int = Query(1, ge=1, description="Page number"),
    limit: int = Query(20, ge=1, le=100, description="Items per page"),
    enabled: Optional[bool] = Query(None, description="Filter by enabled status"),
    trigger_type: Optional[FlowTriggerType] = Query(
        None, description="Filter by trigger type"
    ),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    List current user's Flow configurations.

    Returns paginated list of Flows with support for filtering by enabled status
    and trigger type.
    """
    skip = (page - 1) * limit

    items, total = flow_service.list_flows(
        db=db,
        user_id=current_user.id,
        skip=skip,
        limit=limit,
        enabled=enabled,
        trigger_type=trigger_type,
    )

    return FlowListResponse(total=total, items=items)


@router.post("", response_model=FlowInDB, status_code=status.HTTP_201_CREATED)
def create_flow(
    flow_in: FlowCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Create a new Flow configuration.

    The Flow will be created with the specified trigger configuration and
    associated with the given Team (Agent).
    """
    return flow_service.create_flow(
        db=db,
        flow_in=flow_in,
        user_id=current_user.id,
    )


# ========== Execution History Endpoints (Timeline) ==========
# NOTE: These static routes MUST be defined before /{flow_id} dynamic routes


@router.get("/executions", response_model=FlowExecutionListResponse)
def list_executions(
    page: int = Query(1, ge=1, description="Page number"),
    limit: int = Query(50, ge=1, le=100, description="Items per page"),
    flow_id: Optional[int] = Query(None, description="Filter by flow ID"),
    status: Optional[List[FlowExecutionStatus]] = Query(
        None, description="Filter by execution status"
    ),
    start_date: Optional[datetime] = Query(None, description="Filter by start date"),
    end_date: Optional[datetime] = Query(None, description="Filter by end date"),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    List Flow execution history (timeline view).

    Returns paginated list of execution records sorted by creation time (newest first).
    Supports filtering by flow, status, and date range.
    """
    skip = (page - 1) * limit

    items, total = flow_service.list_executions(
        db=db,
        user_id=current_user.id,
        skip=skip,
        limit=limit,
        flow_id=flow_id,
        status=status,
        start_date=start_date,
        end_date=end_date,
    )

    return FlowExecutionListResponse(total=total, items=items)


@router.get("/executions/stale", response_model=List[FlowExecutionInDB])
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

    from app.models.flow import FlowExecution

    # Calculate threshold
    threshold = datetime.utcnow() - timedelta(hours=hours)

    # Build query - only show user's own executions
    query = db.query(FlowExecution).filter(
        FlowExecution.user_id == current_user.id,
        FlowExecution.created_at < threshold,
    )

    # Filter by status if provided
    if execution_status:
        query = query.filter(FlowExecution.status == execution_status)

    executions = query.order_by(FlowExecution.created_at.desc()).limit(50).all()

    # Convert to FlowExecutionInDB
    from app.models.flow import FlowResource
    from app.models.kind import Kind
    from app.schemas.flow import Flow

    result = []
    for exec in executions:
        exec_dict = {
            "id": exec.id,
            "user_id": exec.user_id,
            "flow_id": exec.flow_id,
            "task_id": exec.task_id,
            "trigger_type": exec.trigger_type,
            "trigger_reason": exec.trigger_reason,
            "prompt": exec.prompt,
            "status": FlowExecutionStatus(exec.status),
            "result_summary": exec.result_summary,
            "error_message": exec.error_message,
            "retry_attempt": exec.retry_attempt,
            "started_at": exec.started_at,
            "completed_at": exec.completed_at,
            "created_at": exec.created_at,
            "updated_at": exec.updated_at,
        }

        # Get flow details
        flow = db.query(FlowResource).filter(FlowResource.id == exec.flow_id).first()
        if flow:
            flow_crd = Flow.model_validate(flow.json)
            exec_dict["flow_name"] = flow.name
            exec_dict["flow_display_name"] = flow_crd.spec.displayName
            exec_dict["task_type"] = flow_crd.spec.taskType.value

            if flow.team_id:
                team = db.query(Kind).filter(Kind.id == flow.team_id).first()
                if team:
                    exec_dict["team_name"] = team.name

        result.append(FlowExecutionInDB(**exec_dict))

    return result


@router.get("/executions/{execution_id}", response_model=FlowExecutionInDB)
def get_execution(
    execution_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Get a specific Flow execution by ID.

    Returns detailed information about the execution including the resolved prompt
    and any result/error messages.
    """
    return flow_service.get_execution(
        db=db,
        execution_id=execution_id,
        user_id=current_user.id,
    )


@router.post("/executions/{execution_id}/cancel", response_model=FlowExecutionInDB)
def cancel_execution(
    execution_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Cancel a running or pending Flow execution.

    This endpoint allows users to manually stop an execution that is in PENDING
    or RUNNING state. Executions in terminal states (COMPLETED, FAILED, CANCELLED)
    cannot be cancelled.

    Returns the updated execution record with CANCELLED status.
    """
    return flow_service.cancel_execution(
        db=db,
        execution_id=execution_id,
        user_id=current_user.id,
    )


# ========== Webhook Trigger Endpoint ==========


@router.post("/webhook/{webhook_token}", response_model=FlowExecutionInDB)
async def trigger_flow_webhook(
    webhook_token: str,
    request: Request,
    x_webhook_signature: Optional[str] = Header(None, alias="X-Webhook-Signature"),
    db: Session = Depends(get_db),
):
    """
    Trigger a Flow via webhook.

    This endpoint is called by external systems to trigger event-based flows.
    The payload will be available as {{webhook_data}} in the prompt template.

    If the Flow has a webhook_secret configured, the request must include
    a valid HMAC-SHA256 signature in the X-Webhook-Signature header.

    Signature format: sha256=<hex_digest>

    To generate the signature:
    1. Get the raw request body
    2. Compute HMAC-SHA256 using the webhook secret
    3. Set header: X-Webhook-Signature: sha256=<hex_digest>
    """
    # Get the flow first to check if signature verification is required
    flow = flow_service.get_flow_by_webhook_token(db, webhook_token=webhook_token)
    if not flow:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Flow not found or disabled",
        )

    # Read the raw body for signature verification
    body = await request.body()

    # Verify signature if the flow has a secret configured
    if flow.webhook_secret:
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
            flow.webhook_secret.encode("utf-8"),
            body,
            hashlib.sha256,
        ).hexdigest()

        # Constant-time comparison to prevent timing attacks
        if not hmac.compare_digest(provided_signature, expected_signature):
            logger.warning(
                f"[webhook] Invalid signature for flow {flow.id}, token={webhook_token[:8]}..."
            )
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid signature",
            )

    # Parse the payload
    payload = {}
    if body:
        try:
            import json

            payload = json.loads(body)
        except json.JSONDecodeError:
            # If not valid JSON, treat as empty payload
            pass

    return flow_service.trigger_flow_by_webhook(
        db=db,
        webhook_token=webhook_token,
        payload=payload,
    )


# ========== Flow CRUD with Dynamic ID ==========
# NOTE: Dynamic routes MUST come after static routes like /executions


@router.get("/{flow_id}", response_model=FlowInDB)
def get_flow(
    flow_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Get a specific Flow configuration by ID.
    """
    return flow_service.get_flow(
        db=db,
        flow_id=flow_id,
        user_id=current_user.id,
    )


@router.put("/{flow_id}", response_model=FlowInDB)
def update_flow(
    flow_id: int,
    flow_in: FlowUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Update an existing Flow configuration.

    Any fields not provided will retain their current values.
    """
    return flow_service.update_flow(
        db=db,
        flow_id=flow_id,
        flow_in=flow_in,
        user_id=current_user.id,
    )


@router.delete("/{flow_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_flow(
    flow_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Delete a Flow configuration (soft delete).

    The Flow will be marked as inactive and disabled.
    """
    flow_service.delete_flow(
        db=db,
        flow_id=flow_id,
        user_id=current_user.id,
    )


@router.post("/{flow_id}/toggle", response_model=FlowInDB)
def toggle_flow(
    flow_id: int,
    enabled: bool = Query(..., description="Enable or disable the flow"),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Enable or disable a Flow.

    When enabled, scheduled flows will resume executing according to their
    trigger configuration. When disabled, no new executions will be triggered.
    """
    return flow_service.toggle_flow(
        db=db,
        flow_id=flow_id,
        user_id=current_user.id,
        enabled=enabled,
    )


@router.post("/{flow_id}/trigger", response_model=FlowExecutionInDB)
def trigger_flow(
    flow_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Manually trigger a Flow execution.

    Creates a new execution record and queues the task for immediate execution.
    This is useful for testing flows or running them outside their normal schedule.
    """
    return flow_service.trigger_flow_manually(
        db=db,
        flow_id=flow_id,
        user_id=current_user.id,
    )
