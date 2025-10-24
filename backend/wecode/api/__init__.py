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
from wecode.api.job_patch import start_git_repositories_update_worker

api_router.include_router(auth_router, prefix="/internal/auth", tags=["internal"])

# 直接启动仓库缓存更新任务，延迟执行
import threading
import time

def _delayed_start():
    # 延迟1分钟后启动，避免与应用启动冲突
    delay_seconds = 60
    time.sleep(delay_seconds)
    start_git_repositories_update_worker()

# 创建并启动延迟执行线程
delayed_thread = threading.Thread(
    target=_delayed_start,
    name="delayed-git-update-starter",
    daemon=True
)
delayed_thread.start()