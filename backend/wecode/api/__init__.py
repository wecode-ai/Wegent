# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Internal API endpoints
"""
from fastapi import APIRouter
from wecode.api.auth import router as auth_router
import wecode.api.gitlab_provider_patch  # noqa: F401  ensures GitLabProvider is monkey-patched at import time
import wecode.api.users_endpoint_patch  # noqa: F401  patch app.api.endpoints.users without modifying source
import wecode.api.user_service_patch    # noqa: F401  patch app.services.user without modifying source

internal_router = APIRouter(prefix="/internal")

internal_router.include_router(auth_router, prefix="/auth", tags=["internal"])