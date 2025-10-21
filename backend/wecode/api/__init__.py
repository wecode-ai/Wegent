# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Internal API endpoints
"""
from app.api.router import api_router
from wecode.api.auth import router as auth_router
import wecode.api.gitlab_provider_patch  # noqa: F401  ensures GitLabProvider is monkey-patched at import time
import wecode.api.users_endpoint_patch  # noqa: F401  patch app.api.endpoints.users without modifying source
import wecode.api.user_service_patch    # noqa: F401  patch app.services.user without modifying source
import wecode.api.models_endpoint_patch # noqa: F401  patch app.api.endpoints.models to enforce admin-only endpoints
import wecode.api.agents_endpoint_patch # noqa: F401  patch app.api.endpoints.agents to enforce admin-only endpoints
import wecode.api.oidc_endpoint_patch   # noqa: F401  patch app.api.endpoints.oidc OIDC callback for wecode-specific git_info handling
import wecode.api.executors_endpoint_patch # noqa: F401  patch app.api.endpoints.executors /tasks/dispatch to replace API key placeholders
import wecode.api.quota_endpoint_patch  # noqa: F401  patch app.api.endpoints.quota to proxy quota requests to external service

api_router.include_router(auth_router, prefix="/internal/auth", tags=["internal"])