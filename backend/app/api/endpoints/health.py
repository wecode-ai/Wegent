# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.graceful_shutdown import (
    ServiceStatus,
    graceful_shutdown_manager,
)

router = APIRouter()


class ServiceStatusResponse(BaseModel):
    """Response model for service status."""

    status: str
    http_code: int
    active_requests: int


class SetServiceStatusRequest(BaseModel):
    """Request model for setting service status."""

    status: str  # "healthy" or "draining"


class SetServiceStatusResponse(BaseModel):
    """Response model for setting service status."""

    success: bool
    status: str
    message: str


class ActiveRequestsResponse(BaseModel):
    """Response model for active requests count."""

    active_requests: int
    has_active_requests: bool


@router.get("/health")
def health_check(db: Session = Depends(get_db)):
    """
    Health check endpoint that verifies:
    1. API is responding
    2. Database connection is working
    3. Database has been initialized (has tables)

    Returns:
        dict: Health status with details
    """
    try:
        # Check database connection by querying users table
        result = db.execute(text("SELECT COUNT(*) FROM users"))
        user_count = result.scalar()

        return {
            "status": "healthy",
            "database": "connected",
            "users_initialized": user_count > 0,
            "user_count": user_count,
        }
    except Exception as e:
        return {"status": "unhealthy", "database": "error", "error": str(e)}


@router.get("/ready")
def readiness_check(db: Session = Depends(get_db)):
    """
    Readiness check endpoint for E2E tests and deployments.
    Returns 200 only when the database is fully initialized with users.

    Returns:
        dict: Readiness status
    """
    try:
        # Check if database has users (initialization complete)
        result = db.execute(text("SELECT COUNT(*) FROM users"))
        user_count = result.scalar()

        if user_count > 0:
            return {
                "status": "ready",
                "database": "initialized",
                "user_count": user_count,
            }
        else:
            # Return 503 if database is not initialized yet
            raise HTTPException(
                status_code=503, detail="Database not initialized yet - no users found"
            )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"Service not ready: {str(e)}")


@router.get(
    "/service-status",
    response_model=ServiceStatusResponse,
    summary="Get service status for graceful shutdown",
    description="""
    Get the current service status for load balancer health checks.

    This endpoint is used for graceful shutdown coordination:
    - Returns 200 with status="healthy" when service is accepting requests
    - Returns 503 with status="draining" when service is preparing to shutdown

    Load balancers should use this endpoint to determine if the service
    should receive traffic.
    """,
)
async def get_service_status(response: Response):
    """
    Get the current service status.

    Returns:
        - 200 with {"status": "healthy", "http_code": 200} when healthy
        - 503 with {"status": "draining", "http_code": 503} when draining
    """
    status = await graceful_shutdown_manager.get_service_status()
    active_requests = await graceful_shutdown_manager.get_active_requests_count()

    if status == ServiceStatus.DRAINING:
        response.status_code = 503
        return ServiceStatusResponse(
            status=ServiceStatus.DRAINING.value,
            http_code=503,
            active_requests=active_requests,
        )

    return ServiceStatusResponse(
        status=ServiceStatus.HEALTHY.value,
        http_code=200,
        active_requests=active_requests,
    )


@router.post(
    "/service-status",
    response_model=SetServiceStatusResponse,
    summary="Set service status for graceful shutdown",
    description="""
    Set the service status for graceful shutdown coordination.

    This endpoint is used to control the service status:
    - Set to "draining" before shutdown to stop receiving new traffic
    - Set to "healthy" to resume accepting traffic

    When set to "draining", the /service-status GET endpoint will return 503,
    signaling load balancers to stop sending new requests.

    **Note**: This endpoint should be protected in production environments.
    """,
)
async def set_service_status(request: SetServiceStatusRequest):
    """
    Set the service status.

    Args:
        request: Contains the status to set ("healthy" or "draining")

    Returns:
        Success status and message
    """
    # Validate status value
    try:
        new_status = ServiceStatus(request.status)
    except ValueError:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid status value: {request.status}. Must be 'healthy' or 'draining'",
        )

    success = await graceful_shutdown_manager.set_service_status(new_status)

    if not success:
        raise HTTPException(
            status_code=500,
            detail="Failed to set service status. Redis may not be available.",
        )

    return SetServiceStatusResponse(
        success=True,
        status=new_status.value,
        message=f"Service status set to {new_status.value}",
    )


@router.get(
    "/active-requests",
    response_model=ActiveRequestsResponse,
    summary="Get active requests count",
    description="""
    Get the count of currently active HTTP requests being processed.

    This endpoint is used for graceful shutdown coordination to check
    if all in-flight requests have completed before shutting down.

    Active requests include:
    - Regular HTTP requests
    - Streaming requests (SSE)
    - Long-running API calls

    Returns the count of active requests and a boolean indicating
    if there are any active requests.
    """,
)
async def get_active_requests():
    """
    Get the count of active requests.

    Returns:
        - active_requests: Number of currently active requests
        - has_active_requests: Boolean indicating if there are active requests
    """
    count = await graceful_shutdown_manager.get_active_requests_count()

    return ActiveRequestsResponse(
        active_requests=count,
        has_active_requests=count > 0,
    )
