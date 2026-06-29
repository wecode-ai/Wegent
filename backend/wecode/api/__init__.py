# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Internal API endpoints
"""
# Register ERP entity resolver for org_department entity type
from app.services.share.external_entity_resolver import register_entity_resolver
from wecode.service.erp_entity_resolver import ErpEntityResolver

register_entity_resolver("org_department", ErpEntityResolver)

# Register Weibo MCP Provider before MCPProviderRegistry.initialize() is called
# This must be done before importing any modules that trigger app.services.mcp_providers.service import
from app.services.mcp_providers.core.registry import MCPProviderRegistry
from wecode.service.mcp_providers.providers.weibo import WeiboMCPProvider

MCPProviderRegistry.register_plugin(WeiboMCPProvider())

# Register Weibo Skill Market Provider
from app.services.skill_market.provider import skill_market_registry
from wecode.service.skill_market import weibo_skill_market_provider

skill_market_registry.register(weibo_skill_market_provider)

import wecode.api.agents_endpoint_patch  # noqa: F401  patch app.api.endpoints.agents to enforce admin-only endpoints
import wecode.api.device_monitor_patch  # noqa: F401  register internal admin restart handler
import wecode.api.executors_endpoint_patch  # noqa: F401  patch /tasks/dispatch endpoint to replace API key placeholders (pull mode, backup)
import wecode.api.gitlab_provider_patch  # noqa: F401  ensures GitLabProvider is monkey-patched at import time
import wecode.api.models_endpoint_patch  # noqa: F401  patch app.api.endpoints.models to enforce admin-only endpoints
import wecode.api.oidc_endpoint_patch  # noqa: F401  patch app.api.endpoints.oidc OIDC callback for wecode-specific git_info handling
import wecode.api.quota_endpoint_patch  # noqa: F401  patch app.api.endpoints.quota to proxy quota requests to external service
import wecode.api.share_service_patch  # noqa: F401  ERP name priority for share members
import wecode.api.user_service_patch  # noqa: F401  patch app.services.user without modifying source
import wecode.api.users_endpoint_patch as users_endpoint_patch  # noqa: F401  patch app.api.endpoints.users without modifying source
import wecode.mcp_server  # noqa: F401  replace external MCP auth with ERP employee_id handler
import wecode.service.cloud_device_monitor_patch  # noqa: F401  register cloud device monitor background worker
import wecode.service.cloud_device_patch  # noqa: F401  register CloudDeviceProvider with factory
import wecode.service.dispatch_tasks_patch  # noqa: F401  patch executor_kinds_service.dispatch_tasks to replace API key placeholders (push mode)
import wecode.service.executor_job_patch  # noqa: F401  patch JobService with K8s orphan pod cleanup capabilities
import wecode.service.executor_kinds_patch  # noqa: F401  patch executor_kinds_service with K8s orphan pod cleanup methods
import wecode.service.jobs  # noqa: F401  register notification and evaluation grading monitor background workers
import wecode.service.local_device_patch  # noqa: F401  register LocalDeviceProvider with factory
import wecode.service.openclaw_token_monitor_patch  # noqa: F401  register OpenClaw token monitor background worker
import wecode.service.request_builder_patch  # noqa: F401  patch TaskRequestBuilder.build to replace ${WECODE_USER_API_KEY} (new dispatcher flow)
import wecode.service.storage_backend_patch  # noqa: F401  register MinIO/S3 storage backends for attachment service
from app.api.endpoints.admin.router import router as admin_router
from app.api.router import api_router
from app.core.config import settings
from wecode.api.admin_published_apps import router as admin_published_apps_router
from wecode.api.apikey import router as apikey_router
from wecode.api.auth import router as auth_router
from wecode.api.cloud_devices import router as cloud_devices_router
from wecode.api.department_search import router as department_search_router
from wecode.api.dept_visibility_admin import router as dept_visibility_admin_router
from wecode.api.evaluation import router as evaluation_router
from wecode.api.mail_devices import router as mail_devices_router
from wecode.api.mail_token import router as mail_token_router
from wecode.api.published_apps import router as published_apps_router
from wecode.api.transition_page import router as transition_page_router
from wecode.api.user_search_with_erp import router as user_search_with_erp_router
from wecode.config.task_sharding_config import task_sharding_settings

task_sharding_store_patch = None
if (
    task_sharding_settings.WECODE_INTERNAL_EXTENSIONS_ENABLED
    and task_sharding_settings.WECODE_TASK_SHARDING_ENABLED
):
    import wecode.task_sharding.store_patch as task_sharding_store_patch

    task_sharding_store_patch.install_task_sharding_store_patch()

api_router.include_router(apikey_router, prefix="/internal/apikey", tags=["internal"])
api_router.include_router(auth_router, prefix="/internal/auth", tags=["internal"])
api_router.include_router(
    department_search_router,
    prefix="/internal/departments",
    tags=["internal"],
)
api_router.include_router(
    dept_visibility_admin_router,
    prefix="/internal/admin/dept-visibility",
    tags=["internal-admin"],
)
api_router.include_router(
    cloud_devices_router, prefix="/cloud-devices", tags=["cloud-devices"]
)
api_router.include_router(evaluation_router, tags=["evaluation"])
api_router.include_router(mail_devices_router, prefix="/devices", tags=["devices"])
api_router.include_router(mail_token_router, prefix="/wecode", tags=["wecode"])
api_router.include_router(
    published_apps_router, prefix="/published-apps", tags=["published-apps"]
)
api_router.include_router(
    transition_page_router, prefix="/v1", tags=["transition-pages"]
)
api_router.include_router(
    user_search_with_erp_router,
    prefix="/wecode/users",
    tags=["wecode"],
)

admin_router.include_router(admin_published_apps_router, tags=["admin-published-apps"])


def finalize_patches() -> None:
    """Apply patches that require all routers to be registered.

    This should be called after all routers are included in api_router.
    """
    users_endpoint_patch.apply_patch()
    return None


def shutdown_patches() -> None:
    """Release resources owned by internal startup patches."""
    if task_sharding_store_patch is not None:
        task_sharding_store_patch.shutdown_task_sharding_store_patch()
