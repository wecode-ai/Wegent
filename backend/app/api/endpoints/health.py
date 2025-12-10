# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.api.dependencies import get_db

router = APIRouter()


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
            from fastapi import HTTPException

            raise HTTPException(
                status_code=503, detail="Database not initialized yet - no users found"
            )
    except Exception as e:
        from fastapi import HTTPException

        raise HTTPException(status_code=503, detail=f"Service not ready: {str(e)}")
