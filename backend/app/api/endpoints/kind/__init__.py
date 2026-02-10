# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Kubernetes-style API endpoints
"""
from fastapi import APIRouter

from app.api.endpoints.kind.batch import router as batch_router
from app.api.endpoints.kind.kinds import router as kinds_router
from app.api.endpoints.kind.skill_marketplace import router as skill_marketplace_router
from app.api.endpoints.kind.skills import router as skills_router

# Create main kind API router
k_router = APIRouter(prefix="/v1")

# Include batch router first to avoid path conflicts
k_router.include_router(batch_router, tags=["kinds-batch"])
# Include skills router
k_router.include_router(skills_router, prefix="/kinds/skills", tags=["skills"])
# Include skill marketplace router
k_router.include_router(
    skill_marketplace_router, prefix="/kinds/skills", tags=["skill-marketplace"]
)
# Include unified kinds router after batch router
k_router.include_router(kinds_router, tags=["kinds"])
