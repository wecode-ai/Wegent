# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
During graceful shutdown:
- /health returns 200 (app is still alive)
- /ready returns 503 (stop sending new traffic)
- /startup returns 200 (startup is complete)
"""

from fastapi import APIRouter, Depends, Response
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.shutdown import shutdown_manager

router = APIRouter()


@router.get("/health")
def health_check(db: Session = Depends(get_db)):
    """
    Liveness probe endpoint for Kubernetes.

    This endpoint checks if the application is alive and responding.
    It should return 200 even during graceful shutdown (app is still alive,
    just not accepting new traffic).
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
            "shutting_down": shutdown_manager.is_shutting_down,
        }
    except Exception as e:
        return {"status": "unhealthy", "database": "error", "error": str(e)}


@router.get("/ready")
def readiness_check(response: Response, db: Session = Depends(get_db)):
    """
    This endpoint checks if the application is ready to receive traffic.
    Returns 503 during graceful shutdown to stop receiving new requests.
    Returns:
        dict: Readiness status
    """
    # During shutdown, return 503 to stop receiving new traffic
    if shutdown_manager.is_shutting_down:
        response.status_code = 503
        return {
            "status": "shutting_down",
            "message": "Service is shutting down, not accepting new traffic",
            "active_streams": shutdown_manager.get_active_stream_count(),
            "shutdown_duration": shutdown_manager.shutdown_duration,
        }

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
            response.status_code = 503
            return {
                "status": "not_ready",
                "message": "Database not initialized yet - no users found",
            }
    except Exception as e:
        response.status_code = 503
        return {
            "status": "not_ready",
            "message": f"Service not ready: {str(e)}",
        }


@router.get("/startup")
def startup_check(db: Session = Depends(get_db)):
    """
    This endpoint checks if the application has finished starting up.
    Unlike readiness, this doesn't return 503 during shutdown because
    the startup phase is already complete.

    Returns:
        dict: Startup status
    """
    try:
        # Check if database is accessible and has users
        result = db.execute(text("SELECT COUNT(*) FROM users"))
        user_count = result.scalar()

        if user_count > 0:
            return {
                "status": "started",
                "database": "initialized",
                "user_count": user_count,
            }
        else:
            from fastapi import HTTPException

            raise HTTPException(
                status_code=503,
                detail="Startup not complete - database not initialized",
            )
    except Exception as e:
        from fastapi import HTTPException

        raise HTTPException(status_code=503, detail=f"Startup failed: {str(e)}")
