# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Internal API endpoints
"""
import logging

# Register ERP entity resolver for org_department entity type
from app.services.external_entity_resolver import register_entity_resolver
from app.services.knowledge.document_download_policy import (
    set_document_download_allowed_resolver,
)
from wecode.service.erp_entity_resolver import ErpEntityResolver
from wecode.service.knowledge.document_protection_policy import (
    is_internal_original_download_allowed,
)

logger = logging.getLogger(__name__)

register_entity_resolver("org_department", ErpEntityResolver)
set_document_download_allowed_resolver(is_internal_original_download_allowed)

# Register Weibo MCP Provider before MCPProviderRegistry.initialize() is called
# This must be done before importing any modules that trigger app.services.mcp_providers.service import
from app.services.mcp_providers.core.registry import MCPProviderRegistry
from wecode.service.mcp_providers.providers.weibo import WeiboMCPProvider

MCPProviderRegistry.register_plugin(WeiboMCPProvider())

# Register Weibo Skill Market Provider
from app.services.skill_market.provider import skill_market_registry
from wecode.service.skill_market import weibo_skill_market_provider

skill_market_registry.register(weibo_skill_market_provider)

# Register Weibo System Skill Provider
from app.services.system_skill_providers.core.registry import (
    system_skill_provider_registry,
)
from wecode.service.system_skill_providers import weibo_system_skill_provider

system_skill_provider_registry.register(weibo_system_skill_provider)

# Replace the open-source remote device command policy with the internal one.
from app.services.device.remote_device_startup import (
    register_remote_device_command_provider,
)
from wecode.config.remote_device_config import remote_device_settings
from wecode.service.remote_device_startup_provider import (
    WecodeRemoteDeviceCommandProvider,
)

register_remote_device_command_provider(
    WecodeRemoteDeviceCommandProvider(remote_device_settings)
)

import wecode.api.agents_endpoint_patch  # noqa: F401  patch app.api.endpoints.agents to enforce admin-only endpoints
import wecode.api.device_monitor_patch  # noqa: F401  register internal admin restart handler
import wecode.api.executors_endpoint_patch  # noqa: F401  patch /tasks/dispatch endpoint to replace API key placeholders (pull mode, backup)
import wecode.api.gitlab_provider_patch  # noqa: F401  ensures GitLabProvider is monkey-patched at import time
import wecode.api.models_endpoint_patch  # noqa: F401  patch app.api.endpoints.models to enforce admin-only endpoints
import wecode.api.oidc_endpoint_patch  # noqa: F401  patch app.api.endpoints.oidc OIDC callback for wecode-specific git_info handling
import wecode.api.outbound_token_service_patch  # noqa: F401  inject employee_id claim into issued outbound tokens
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
import wecode.service.git_execution_credentials  # noqa: F401  register task-scoped Git token resolution
import wecode.service.jobs  # noqa: F401  register notification and evaluation grading monitor background workers
import wecode.service.knowledge.weibo_dispatch_validator  # noqa: F401  register Weibo dispatch validator (replaces weibo_multimodal_patch monkeypatch)
import wecode.service.knowledge.weibo_video_upload_provider  # noqa: F401  register Weibo VideoUploadProvider (two-phase KB video upload)
import wecode.service.llm_proxy_service_patch  # noqa: F401  resolve user API keys for the LLM proxy gateway
import wecode.service.local_device_patch  # noqa: F401  register LocalDeviceProvider with factory
import wecode.service.openclaw_token_monitor_patch  # noqa: F401  register OpenClaw token monitor background worker
import wecode.service.request_builder_patch  # noqa: F401  patch TaskRequestBuilder.build to replace ${WECODE_USER_API_KEY} (new dispatcher flow)
import wecode.service.storage_backend_patch  # noqa: F401  register MinIO/S3 storage backends for attachment service
from app.api.endpoints.admin.router import router as admin_router
from app.api.router import api_router
from app.core.asgi_extensions import register_asgi_wrapper
from app.core.config import settings
from wecode.api.admin_published_apps import router as admin_published_apps_router
from wecode.api.agent_usage import router as agent_usage_router
from wecode.api.apikey import router as apikey_router
from wecode.api.auth import router as auth_router
from wecode.api.cloud_device_ip_index import router as cloud_device_ip_index_router
from wecode.api.cloud_devices import router as cloud_devices_router
from wecode.api.department_search import router as department_search_router
from wecode.api.dept_visibility_admin import router as dept_visibility_admin_router
from wecode.api.evaluation import router as evaluation_router
from wecode.api.external_knowledge import router as external_knowledge_router
from wecode.api.internal.attachments_video import (
    router as internal_attachments_video_router,
)
from wecode.api.internal.multimodal_gcs import router as internal_multimodal_gcs_router
from wecode.api.ip_user_lookup import router as ip_user_lookup_router
from wecode.api.knowledge_document_protection import (
    router as knowledge_document_protection_router,
)
from wecode.api.knowledge_video_download import (
    router as knowledge_video_download_router,
)
from wecode.api.knowledge_video_play import router as knowledge_video_play_router
from wecode.api.mail_devices import router as mail_devices_router
from wecode.api.mail_token import router as mail_token_router
from wecode.api.published_apps import router as published_apps_router
from wecode.api.transition_page import router as transition_page_router
from wecode.api.user_search_with_erp import router as user_search_with_erp_router
from wecode.api.vnc_websocket_middleware import create_vnc_interceptor_app
from wecode.config.task_sharding_config import task_sharding_settings
from wecode.runtime import initialize_internal_runtime
from wecode.video.api.router import router as aigc_video_router

initialize_internal_runtime()

# Register the Wecode VNC WebSocket interceptor as a distribution-owned ASGI
# wrapper so ``app.main`` can apply it without importing internal modules.
register_asgi_wrapper("device-vnc", create_vnc_interceptor_app)

task_sharding_store_patch = None
if (
    task_sharding_settings.WECODE_INTERNAL_EXTENSIONS_ENABLED
    and task_sharding_settings.WECODE_TASK_SHARDING_ENABLED
):
    import wecode.task_sharding.store_patch as task_sharding_store_patch

    task_sharding_store_patch.install_task_sharding_store_patch()


def _register_ap_external_knowledge_provider() -> None:
    try:
        from wecode.config.external_knowledge_config import external_knowledge_settings
        from wecode.service.external_knowledge.providers.ap import (
            ApExternalKnowledgeProvider,
        )

        provider = ApExternalKnowledgeProvider(external_knowledge_settings)
    except Exception as exc:
        message = "[wecode] Failed to initialize AP external knowledge provider"
        logger.error(message, exc_info=True)
        _register_unavailable_external_knowledge_provider("ap", str(exc) or message)
        return

    try:
        from app.services.rag.sources import retrieval_source_registry
        from wecode.service.external_knowledge.registry import (
            register as register_external_knowledge,
        )

        register_external_knowledge(provider)
        retrieval_source_registry.register(provider)
    except Exception as exc:
        message = "[wecode] Failed to register AP external knowledge provider"
        logger.error(message, exc_info=True)
        _register_unavailable_external_knowledge_provider("ap", str(exc) or message)


def _register_unavailable_external_knowledge_provider(name: str, reason: str) -> None:
    try:
        from app.services.rag.sources import retrieval_source_registry
        from wecode.service.external_knowledge.registry import (
            register as register_external_knowledge,
        )
        from wecode.service.external_knowledge.unavailable import (
            UnavailableExternalKnowledgeProvider,
        )

        provider = UnavailableExternalKnowledgeProvider(name, reason)
        register_external_knowledge(provider)
        retrieval_source_registry.register(provider)
    except Exception:
        logger.error(
            "[wecode] Failed to register unavailable external knowledge provider",
            exc_info=True,
        )


_register_ap_external_knowledge_provider()

api_router.include_router(apikey_router, prefix="/internal/apikey", tags=["internal"])
api_router.include_router(
    agent_usage_router,
    prefix="/wecode/agent-usage",
    tags=["wecode", "agent-usage"],
)
api_router.include_router(auth_router, prefix="/internal/auth", tags=["internal"])
api_router.include_router(aigc_video_router, prefix="/aigc-video", tags=["aigc-video"])
# Internal multimodal endpoints (converter-facing): GCS proxy + fid→CDN resolver.
# attachments_video provides GET /attachments/{id}/video-download-url (injected
# into MultimodalDispatchContext.video_download_url_path by weibo_multimodal_patch).
api_router.include_router(
    internal_attachments_video_router, prefix="/internal", tags=["internal"]
)
api_router.include_router(
    internal_multimodal_gcs_router, prefix="/internal", tags=["internal"]
)
# User-facing KB video download stream proxy (bridges internal Weibo CDN/OSS).
api_router.include_router(
    knowledge_video_download_router,
    prefix="/knowledge-documents",
    tags=["knowledge-video-download"],
)
# User-facing KB video playback URL resolver (returns a signed CDN URL; the
# browser <video src> reaches Weibo CDN directly, no byte proxying).
api_router.include_router(
    knowledge_video_play_router,
    prefix="/knowledge-documents",
    tags=["knowledge-video-play"],
)
api_router.include_router(
    knowledge_document_protection_router,
    prefix="/wecode",
    tags=["wecode", "knowledge-document-protection"],
)
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
    ip_user_lookup_router,
    prefix="/internal/admin/users",
    tags=["internal-admin"],
)
api_router.include_router(
    cloud_device_ip_index_router,
    prefix="/internal/admin/cloud-device-ip-index",
    tags=["internal-admin"],
)
api_router.include_router(
    cloud_devices_router, prefix="/cloud-devices", tags=["cloud-devices"]
)
api_router.include_router(evaluation_router, tags=["evaluation"])
api_router.include_router(
    external_knowledge_router,
    prefix="/wecode/external-knowledge",
    tags=["wecode", "external-knowledge"],
)
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
