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

# Optional: auto-mount internal_router to the global api_router without modifying app/api/api.py
# This keeps open-source files unchanged. If app.api.router.api_router is importable at this time,
# we include our internal router here; otherwise we fail silently.
try:
    from app.api.router import api_router as _global_api_router
    _global_api_router.include_router(internal_router)
except Exception:
    # In early import orders this may fail; it's safe to ignore because app/api/api.py
    # could also include the internal router explicitly in internal branches.
    pass