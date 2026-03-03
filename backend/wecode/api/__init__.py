# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Internal API endpoints
"""
# Register Weibo MCP Provider before MCPProviderRegistry.initialize() is called
# This must be done before importing any modules that trigger app.services.mcp_providers.service import
from app.services.mcp_providers.core.registry import MCPProviderRegistry
from wecode.service.mcp_providers.providers.weibo import WeiboMCPProvider

MCPProviderRegistry.register_plugin(WeiboMCPProvider())

import wecode.api.agents_endpoint_patch  # noqa: F401  patch app.api.endpoints.agents to enforce admin-only endpoints

# import wecode.api.device_router_patch  # noqa: F401  patch app.services.device_router to replace API key placeholders for device task dispatch
import wecode.api.executors_endpoint_patch  # noqa: F401  patch /tasks/dispatch endpoint to replace API key placeholders (pull mode, backup)
import wecode.api.gitlab_provider_patch  # noqa: F401  ensures GitLabProvider is monkey-patched at import time
import wecode.api.models_endpoint_patch  # noqa: F401  patch app.api.endpoints.models to enforce admin-only endpoints
import wecode.api.oidc_endpoint_patch  # noqa: F401  patch app.api.endpoints.oidc OIDC callback for wecode-specific git_info handling
import wecode.api.quota_endpoint_patch  # noqa: F401  patch app.api.endpoints.quota to proxy quota requests to external service
import wecode.api.user_service_patch  # noqa: F401  patch app.services.user without modifying source
import wecode.api.users_endpoint_patch  # noqa: F401  patch app.api.endpoints.users without modifying source
import wecode.service.cloud_device_patch  # noqa: F401  register CloudDeviceProvider with factory

# import wecode.service.device_service_patch  # noqa: F401  patch DeviceService to aggregate cloud devices
import wecode.service.dispatch_tasks_patch  # noqa: F401  patch executor_kinds_service.dispatch_tasks to replace API key placeholders (push mode)
import wecode.service.local_device_patch  # noqa: F401  register LocalDeviceProvider with factory
import wecode.service.request_builder_patch  # noqa: F401  patch TaskRequestBuilder.build to replace ${WECODE_USER_API_KEY} (new dispatcher flow)
import wecode.service.storage_backend_patch  # noqa: F401  register MinIO/S3 storage backends for attachment service
from app.api.router import api_router
from wecode.api.auth import router as auth_router
from wecode.api.cloud_devices import router as cloud_devices_router
from wecode.api.evaluation import router as evaluation_router

api_router.include_router(auth_router, prefix="/internal/auth", tags=["internal"])
api_router.include_router(
    cloud_devices_router, prefix="/cloud-devices", tags=["cloud-devices"]
)
api_router.include_router(evaluation_router, tags=["evaluation"])
