"""
API router configuration.
"""
from fastapi import APIRouter

from app.api.endpoints import analytics, config, evaluation, health, reports, sync, version

api_router = APIRouter()

# Health check endpoints
api_router.include_router(health.router, tags=["health"])

# Sync endpoints
api_router.include_router(sync.router, prefix="/sync", tags=["sync"])

# Evaluation endpoints
api_router.include_router(evaluation.router, prefix="/evaluation", tags=["evaluation"])

# Analytics endpoints
api_router.include_router(analytics.router, prefix="/analytics", tags=["analytics"])

# Config endpoints
api_router.include_router(config.router, prefix="/settings", tags=["settings"])

# Version endpoints
api_router.include_router(version.router, prefix="/versions", tags=["versions"])

# Report endpoints
api_router.include_router(reports.router, prefix="/reports", tags=["reports"])
