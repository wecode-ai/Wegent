# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Router aggregation for knowledge_runtime API endpoints."""

from __future__ import annotations

from fastapi import APIRouter

from knowledge_runtime.api.endpoints import admin, health, index, query

router = APIRouter()

# Health check endpoint (no auth required)
router.include_router(health.router, tags=["health"])

# RAG operation endpoints (auth required)
router.include_router(index.router, prefix="/internal/rag", tags=["index"])
router.include_router(query.router, prefix="/internal/rag", tags=["query"])
router.include_router(admin.router, prefix="/internal/rag", tags=["admin"])
