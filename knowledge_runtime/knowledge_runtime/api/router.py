# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Router aggregation for knowledge_runtime API endpoints."""

from __future__ import annotations

from fastapi import APIRouter, Depends
from knowledge_runtime.api.endpoints import admin, health, index, kb_stat, query
from knowledge_runtime.middleware.auth import verify_internal_token

router = APIRouter()

# Health check endpoint (no auth required)
router.include_router(health.router, tags=["health"])

# RAG operation endpoints (auth required)
router.include_router(
    index.router,
    prefix="/internal/rag",
    tags=["index"],
    dependencies=[Depends(verify_internal_token)],
)
router.include_router(
    query.router,
    prefix="/internal/rag",
    tags=["query"],
    dependencies=[Depends(verify_internal_token)],
)
router.include_router(
    admin.router,
    prefix="/internal/rag",
    tags=["admin"],
    dependencies=[Depends(verify_internal_token)],
)

# KB stat endpoints (auth required)
router.include_router(
    kb_stat.router,
    prefix="/internal/kb-stat",
    tags=["kb-stat"],
    dependencies=[Depends(verify_internal_token)],
)
