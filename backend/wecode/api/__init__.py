# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Internal API endpoints
"""
from fastapi import APIRouter
from wecode.api.auth import router as auth_router

internal_router = APIRouter(prefix="/internal")

internal_router.include_router(auth_router, prefix="/auth", tags=["internal"])