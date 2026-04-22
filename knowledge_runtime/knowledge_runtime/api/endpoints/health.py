# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Health check endpoint for knowledge_runtime service."""

from __future__ import annotations

from fastapi import APIRouter

router = APIRouter()


@router.get("/internal/rag/health")
async def health_check() -> dict[str, str]:
    """Health check endpoint.

    Returns:
        Simple health status dictionary.
    """
    return {"status": "healthy"}
