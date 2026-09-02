# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import io
import logging
from dataclasses import dataclass
from urllib.parse import quote

from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    HTTPException,
    Request,
    UploadFile,
    status,
)
from fastapi.responses import StreamingResponse
from jose import JWTError, jwt

from app.core import security
from app.core.config import settings
from app.core.payload_codec import dump_models, run_payload_codec
from app.models.user import User
from app.schemas.device import DeviceCapabilitySyncResponse
from app.schemas.installed_plugin import (
    BuiltinPluginInstallRequest,
    InstalledPlugin,
    InstalledPluginListResponse,
    InstalledPluginUpdateRequest,
    PluginAccessResponse,
    PluginAccessUpdateRequest,
    PluginAutoUpdateBatchResponse,
    PluginCopyResponse,
    PluginDeleteImpactResponse,
    PluginDeleteRequest,
    PluginDeleteResponse,
    PluginDeviceReportRequest,
    PluginDeviceReportResponse,
    PluginDeviceSyncResponse,
    PluginMarketplaceCapabilities,
    PluginMarketplaceInstallResponse,
    PluginMarketplaceItem,
    PluginMarketplaceListResponse,
    PluginReleaseListResponse,
    PluginSubmissionCompleteResponse,
    PluginSubmissionInitRequest,
    PluginSubmissionInitResponse,
    PluginSubmissionItem,
)
from app.services.auth.task_token import TaskTokenInfo, verify_task_token
from app.services.chat.storage.db import run_sync_in_executor
from app.services.device.capability_sync_service import (
    DeviceCapabilityResolutionError,
    DeviceCapabilitySyncError,
    device_capability_sync_service,
)
from app.services.plugin_device_installation_service import (
    plugin_device_installation_service,
)
from app.services.plugin_endpoint_db import plugin_endpoint_db
from app.services.plugin_package_parser import MAX_PLUGIN_PACKAGE_SIZE_BYTES
from app.services.plugin_package_storage import PluginPackageStorageError

router = APIRouter(tags=["plugins"])
logger = logging.getLogger(__name__)
PLUGIN_UPLOAD_CHUNK_SIZE_BYTES = 1024 * 1024


@dataclass(frozen=True)
class PluginSubmissionAuth:
    user_id: int
    user_role: str
    task_token: TaskTokenInfo | None = None


def _task_token_from_authorization(authorization: str) -> TaskTokenInfo | None:
    token = security.extract_authorization_token(authorization)
    if not token:
        return None
    try:
        # Unverified claims only select the parser; verify_task_token authenticates it.
        if jwt.get_unverified_claims(token).get("type") != "task_token":
            return None
    except JWTError:
        return None
    return verify_task_token(token)


async def _get_plugin_submission_auth(
    request: Request,
    current_user: User = Depends(security.get_current_user_jwt_apikey_tasktoken),
) -> PluginSubmissionAuth:
    """Restrict task-token submission access to its live Task execution."""
    user_id = current_user.id
    user_role = current_user.role
    del current_user
    if request.headers.get("X-API-Key", "").strip():
        return PluginSubmissionAuth(user_id=user_id, user_role=user_role)

    authorization = request.headers.get("Authorization", "")
    token_info = await run_payload_codec(
        _task_token_from_authorization,
        authorization,
        payload_hint=authorization,
        force_offload=True,
    )
    if token_info is None:
        return PluginSubmissionAuth(user_id=user_id, user_role=user_role)

    await run_sync_in_executor(
        plugin_endpoint_db.validate_task_token,
        user_id,
        token_info,
    )
    return PluginSubmissionAuth(
        user_id=user_id,
        user_role=user_role,
        task_token=token_info,
    )


@router.get("/installed", response_model=InstalledPluginListResponse)
async def list_installed_plugins(
    device_id: str | None = None,
    current_user: User = Depends(security.get_current_user),
) -> InstalledPluginListResponse:
    """List Claude Code plugins installed by the current user."""
    # Keep list read-only. Catalog repair runs on install/sync paths instead of
    # every marketplace open.
    user_id = current_user.id
    del current_user
    return await run_sync_in_executor(
        plugin_endpoint_db.list_installed,
        user_id,
        device_id,
    )


@router.post(
    "/installed/auto-update-batch",
    response_model=PluginAutoUpdateBatchResponse,
)
async def auto_update_installed_plugins(
    current_user: User = Depends(security.get_current_user),
) -> PluginAutoUpdateBatchResponse:
    """Advance one bounded batch of cloud marketplace plugin installations."""
    user_id = current_user.id
    del current_user
    return await run_sync_in_executor(
        plugin_endpoint_db.auto_update_batch,
        user_id,
    )


@router.post("/installed/sync-device", response_model=PluginDeviceSyncResponse)
async def sync_installed_plugins_to_device(
    device_id: str,
    current_user: User = Depends(security.get_current_user),
) -> PluginDeviceSyncResponse:
    """Push account desired plugins to one device and refresh device rows."""
    normalized_device_id = device_id.strip()
    if not normalized_device_id:
        raise HTTPException(status_code=400, detail="device_id is required")
    user_id = current_user.id
    del current_user
    plan = await run_sync_in_executor(
        plugin_endpoint_db.prepare_device_sync,
        user_id,
        normalized_device_id,
    )
    result = await device_capability_sync_service.sync_device_payload(
        user_id=user_id,
        device_id=normalized_device_id,
        payload=plan.payload,
    )
    await run_sync_in_executor(
        plugin_endpoint_db.record_device_sync,
        user_id,
        result,
    )
    mode = str(plan.payload.get("mode") or "replace")
    errors = list(result.errors or [])
    if result.error:
        errors.append({"device_id": result.device_id, "error": result.error})
    sync = DeviceCapabilitySyncResponse(
        success=bool(result.success),
        device_id=result.device_id,
        mode=mode if mode in {"merge", "replace"} else "replace",
        skills=result.skills,
        plugins=result.plugins,
        mcps=result.mcps,
        errors=errors,
        synced=1 if result.success else 0,
        failed=0 if result.success else 1,
        skipped=0,
        results=[result],
    )
    logger.info(
        "Device plugin sync completed: user_id=%s device_id=%s pending=%s success=%s",
        user_id,
        normalized_device_id,
        plan.pending_count,
        result.success,
    )
    return PluginDeviceSyncResponse(
        deviceId=normalized_device_id,
        pendingCount=plan.pending_count,
        sync=sync,
    )


@router.post("/installed/report-device", response_model=PluginDeviceReportResponse)
async def report_installed_plugins_on_device(
    payload: PluginDeviceReportRequest,
    device_id: str,
    current_user: User = Depends(security.get_current_user),
) -> PluginDeviceReportResponse:
    """Acknowledge locally present plugins on one device without pushing packages."""
    normalized_device_id = device_id.strip()
    if not normalized_device_id:
        raise HTTPException(status_code=400, detail="device_id is required")
    user_id = current_user.id
    del current_user
    acknowledged_ids = await run_sync_in_executor(
        plugin_endpoint_db.report_device,
        user_id,
        normalized_device_id,
        payload.plugins,
    )
    logger.info(
        "Device plugin status reported: user_id=%s device_id=%s acknowledged=%s",
        user_id,
        normalized_device_id,
        len(acknowledged_ids),
    )
    return PluginDeviceReportResponse(
        deviceId=normalized_device_id,
        acknowledgedCount=len(acknowledged_ids),
        acknowledgedInstalledPluginIds=acknowledged_ids,
    )


@router.get("/capabilities", response_model=PluginMarketplaceCapabilities)
def get_plugin_marketplace_capabilities(
    current_user: User = Depends(security.get_current_user),
) -> PluginMarketplaceCapabilities:
    return PluginMarketplaceCapabilities(
        canPublish=_can_publish(
            user_id=current_user.id,
            user_role=current_user.role,
        ),
        canSharePersonalPlugins=True,
    )


@router.post(
    "/upload",
    response_model=InstalledPlugin,
    status_code=status.HTTP_201_CREATED,
)
async def upload_plugin(
    file: UploadFile = File(...),
    enabled: bool = Form(True),
    current_user: User = Depends(security.get_current_user),
) -> InstalledPlugin:
    """Upload and install a Claude Code plugin ZIP package."""
    user_id = current_user.id
    user_role = current_user.role
    del current_user
    if user_role != "admin" or not settings.PLUGIN_LEGACY_UPLOAD_ENABLED:
        raise HTTPException(
            status_code=410,
            detail="Direct cloud upload is retired; create locally or publish a submission",
        )
    logger.info(
        "Plugin upload requested: user_id=%s filename=%s enabled=%s",
        user_id,
        file.filename,
        enabled,
    )
    content = await _read_plugin_upload(file)
    installed = await run_sync_in_executor(
        plugin_endpoint_db.upload,
        user_id,
        content,
        file.filename or "plugin.zip",
        enabled,
    )
    await _sync_global_capabilities(user_id)
    return installed


@router.get("/marketplace", response_model=PluginMarketplaceListResponse)
async def list_marketplace_plugins(
    q: str | None = None,
    source: str | None = None,
    listing_type: str | None = None,
    device_id: str | None = None,
    current_user: User | None = Depends(security.get_current_user_optional),
) -> PluginMarketplaceListResponse:
    """List Codex-compatible plugins published to the Wegent marketplace.

    This endpoint supports both authenticated and unauthenticated access:
    - Authenticated users see installation status and device-specific info
    - Unauthenticated users see all available plugins without installation status
    """
    user_id = current_user.id if current_user else None
    del current_user
    return await run_sync_in_executor(
        plugin_endpoint_db.list_marketplace,
        user_id,
        q,
        source,
        listing_type,
        device_id,
    )


@router.get("/marketplace/{plugin_id}", response_model=PluginMarketplaceItem)
async def get_marketplace_plugin(
    plugin_id: int,
    device_id: str | None = None,
    current_user: User = Depends(security.get_current_user),
) -> PluginMarketplaceItem:
    user_id = current_user.id
    del current_user
    return await run_sync_in_executor(
        plugin_endpoint_db.get_marketplace,
        plugin_id,
        user_id,
        device_id,
    )


@router.get(
    "/marketplace/{plugin_id}/releases", response_model=PluginReleaseListResponse
)
async def list_marketplace_plugin_releases(
    plugin_id: int,
    current_user: User = Depends(security.get_current_user),
) -> PluginReleaseListResponse:
    user_id = current_user.id
    del current_user
    return await run_sync_in_executor(
        plugin_endpoint_db.list_releases,
        plugin_id,
        user_id,
    )


@router.get(
    "/marketplace/{plugin_id}/access",
    response_model=PluginAccessResponse,
)
async def get_marketplace_plugin_access(
    plugin_id: int,
    current_user: User = Depends(security.get_current_user),
) -> PluginAccessResponse:
    user_id = current_user.id
    del current_user
    return await run_sync_in_executor(
        plugin_endpoint_db.get_access,
        plugin_id,
        user_id,
    )


@router.put(
    "/marketplace/{plugin_id}/access",
    response_model=PluginAccessResponse,
)
async def update_marketplace_plugin_access(
    plugin_id: int,
    request: PluginAccessUpdateRequest,
    current_user: User = Depends(security.get_current_user),
) -> PluginAccessResponse:
    user_id = current_user.id
    del current_user
    plan = await run_sync_in_executor(
        plugin_endpoint_db.update_access,
        plugin_id,
        user_id,
        request,
    )
    for recipient_user_id, installed_id in plan.revoked_installs:
        try:
            await run_sync_in_executor(
                plugin_endpoint_db.mark_uninstalling,
                recipient_user_id,
                installed_id,
            )
            result = await _sync_global_capabilities(
                recipient_user_id,
                required_installed_kind_id=installed_id,
                expect_installed=False,
            )
            await run_sync_in_executor(
                plugin_endpoint_db.record_uninstall,
                recipient_user_id,
                installed_id,
                result,
            )
        except Exception:
            logger.exception(
                "Plugin share revocation sync failed: plugin_id=%s user_id=%s",
                plugin_id,
                recipient_user_id,
            )
    plan.access.revocationPendingCount = len(plan.revoked_installs)
    return plan.access


@router.get(
    "/marketplace/{plugin_id}/delete-impact",
    response_model=PluginDeleteImpactResponse,
)
async def get_marketplace_plugin_delete_impact(
    plugin_id: int,
    current_user: User = Depends(security.get_current_user),
) -> PluginDeleteImpactResponse:
    user_id = current_user.id
    del current_user
    return await run_sync_in_executor(
        plugin_endpoint_db.delete_impact,
        plugin_id,
        user_id,
    )


@router.delete(
    "/marketplace/{plugin_id}",
    response_model=PluginDeleteResponse,
)
async def delete_marketplace_plugin(
    plugin_id: int,
    request: PluginDeleteRequest,
    current_user: User = Depends(security.get_current_user),
) -> PluginDeleteResponse:
    user_id = current_user.id
    del current_user
    installations = await run_sync_in_executor(
        plugin_endpoint_db.delete_marketplace,
        plugin_id,
        user_id,
        request,
    )
    for installation_user_id, installed_id in installations:
        try:
            await run_sync_in_executor(
                plugin_endpoint_db.mark_uninstalling,
                installation_user_id,
                installed_id,
            )
            result = await _sync_global_capabilities(
                installation_user_id,
                required_installed_kind_id=installed_id,
                expect_installed=False,
            )
            await run_sync_in_executor(
                plugin_endpoint_db.record_uninstall,
                installation_user_id,
                installed_id,
                result,
            )
        except Exception:
            logger.exception(
                "Deleted plugin uninstall sync failed: plugin_id=%s user_id=%s",
                plugin_id,
                installation_user_id,
            )
    installation_ids = tuple(installed_id for _, installed_id in installations)
    pending_device_count = await run_sync_in_executor(
        plugin_endpoint_db.pending_device_count,
        installation_ids,
    )
    return PluginDeleteResponse(pendingDeviceCount=pending_device_count)


@router.post(
    "/marketplace/{plugin_id}/copy",
    response_model=PluginCopyResponse,
)
async def copy_marketplace_plugin(
    plugin_id: int,
    current_user: User = Depends(security.get_current_user),
) -> PluginCopyResponse:
    user_id = current_user.id
    del current_user
    try:
        return await run_sync_in_executor(
            plugin_endpoint_db.copy_descriptor,
            plugin_id,
            user_id,
        )
    except PluginPackageStorageError as exc:
        raise HTTPException(
            status_code=503,
            detail="Plugin package storage unavailable",
        ) from exc


@router.post(
    "/marketplace/{marketplace_id}/install",
    response_model=PluginMarketplaceInstallResponse,
)
async def install_marketplace_plugin(
    marketplace_id: int,
    release_id: int | None = None,
    device_id: str | None = None,
    current_user: User = Depends(security.get_current_user),
) -> PluginMarketplaceInstallResponse:
    """Install a marketplace plugin for the current user.

    Account Kind creation is authoritative. Global device sync is best-effort:
    a full replace can fail because of an unrelated plugin while the new install
    is already desired; do not 502 and leave the marketplace UI stuck.
    """
    user_id = current_user.id
    del current_user
    plan = await run_sync_in_executor(
        plugin_endpoint_db.install_marketplace,
        marketplace_id,
        user_id,
        release_id,
    )
    if plan.release_id is not None:
        await plugin_device_installation_service.ensure_pending_for_all_devices(
            user_id=user_id,
            installed_kind_id=plan.installed_id,
            desired_release_id=plan.release_id,
        )
    sync = await _sync_global_capabilities(
        user_id,
        required_device_id=device_id,
        required_installed_kind_id=plan.installed_id,
        expect_installed=True,
        require_device_success=False,
    )
    sync = await _ensure_installed_plugin_on_device(
        user_id=user_id,
        device_id=device_id,
        installed_id=plan.installed_id,
        previous=sync,
    )
    enriched = await run_sync_in_executor(
        plugin_endpoint_db.enrich_installed,
        plan.plugin,
        device_id,
    )
    return PluginMarketplaceInstallResponse(plugin=enriched, sync=sync)


@router.post(
    "/builtin/{plugin_key}/ensure-installed",
    response_model=PluginMarketplaceInstallResponse,
)
async def ensure_builtin_plugin_installed(
    plugin_key: str,
    request: BuiltinPluginInstallRequest,
    current_user: User = Depends(security.get_current_user),
) -> PluginMarketplaceInstallResponse:
    """Install a bundled plugin from the v2 marketplace catalog."""
    user_id = current_user.id
    del current_user
    plan = await run_sync_in_executor(
        plugin_endpoint_db.ensure_builtin,
        plugin_key,
        user_id,
    )
    if plan.legacy:
        return await _ensure_legacy_builtin_plugin_installed(
            request=request,
            plugin=plan.plugin,
            installed_id=plan.installed_id,
            user_id=user_id,
        )
    if plan.release_id is not None:
        await plugin_device_installation_service.ensure_pending_for_all_devices(
            user_id=user_id,
            installed_kind_id=plan.installed_id,
            desired_release_id=plan.release_id,
        )
    sync = await _sync_global_capabilities(
        user_id,
        required_device_id=request.device_id,
        required_installed_kind_id=plan.installed_id,
        expect_installed=True,
        require_device_success=False,
    )
    sync = await _ensure_installed_plugin_on_device(
        user_id=user_id,
        device_id=request.device_id,
        installed_id=plan.installed_id,
        previous=sync,
    )
    enriched = await run_sync_in_executor(
        plugin_endpoint_db.enrich_installed,
        plan.plugin,
        request.device_id,
    )
    return PluginMarketplaceInstallResponse(plugin=enriched, sync=sync)


async def _ensure_legacy_builtin_plugin_installed(
    *,
    request: BuiltinPluginInstallRequest,
    plugin: InstalledPlugin,
    installed_id: int,
    user_id: int,
) -> PluginMarketplaceInstallResponse:
    if request.device_id is None:
        sync = await _sync_global_capabilities(user_id)
        return PluginMarketplaceInstallResponse(plugin=plugin, sync=sync)

    try:
        sync = await device_capability_sync_service.sync_installed_plugin_to_device(
            user_id=user_id,
            device_id=request.device_id,
            installed_plugin_id=installed_id,
        )
    except DeviceCapabilityResolutionError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
    except DeviceCapabilitySyncError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=str(exc),
        ) from exc
    return PluginMarketplaceInstallResponse(plugin=plugin, sync=sync)


async def _read_plugin_upload(file: UploadFile) -> bytes:
    chunks: list[bytes] = []
    total_size = 0
    while True:
        chunk = await file.read(PLUGIN_UPLOAD_CHUNK_SIZE_BYTES)
        if not chunk:
            break
        total_size += len(chunk)
        if total_size > MAX_PLUGIN_PACKAGE_SIZE_BYTES:
            raise HTTPException(status_code=413, detail="Plugin package is too large")
        chunks.append(chunk)
    return b"".join(chunks)


@router.get("/installed/{installed_id}/download")
async def download_installed_plugin(
    installed_id: int,
    current_user: User = Depends(security.get_current_user_jwt_apikey_tasktoken),
) -> StreamingResponse:
    """Download a user's installed plugin package for local executor sync."""
    user_id = current_user.id
    del current_user
    try:
        package_bytes, filename = await run_sync_in_executor(
            plugin_endpoint_db.download_package,
            user_id,
            installed_id,
        )
    except PluginPackageStorageError as exc:
        raise HTTPException(
            status_code=503, detail="Plugin package storage unavailable"
        ) from exc
    encoded_filename = quote(filename, safe="")
    return StreamingResponse(
        io.BytesIO(package_bytes),
        media_type="application/zip",
        headers={
            "Content-Disposition": f"attachment; filename*=UTF-8''{encoded_filename}"
        },
    )


@router.put("/installed/{installed_id}", response_model=InstalledPlugin)
async def update_installed_plugin(
    installed_id: int,
    request: InstalledPluginUpdateRequest,
    device_id: str | None = None,
    current_user: User = Depends(security.get_current_user),
) -> InstalledPlugin:
    """Update an installed plugin's runtime state, metadata, or update policy."""
    user_id = current_user.id
    del current_user
    plan = await run_sync_in_executor(
        plugin_endpoint_db.update_installed,
        user_id,
        installed_id,
        request,
    )
    if plan.release_id is not None:
        await plugin_device_installation_service.ensure_pending_for_all_devices(
            user_id=user_id,
            installed_kind_id=installed_id,
            desired_release_id=plan.release_id,
            reset_failures=request.releaseId is not None,
        )
    await _sync_global_capabilities(
        user_id,
        required_device_id=device_id,
        required_installed_kind_id=installed_id,
        expect_installed=True,
        require_device_success=False,
    )
    await _ensure_installed_plugin_on_device(
        user_id=user_id,
        device_id=device_id,
        installed_id=installed_id,
        manual_retry=request.releaseId is not None,
    )
    return await run_sync_in_executor(
        plugin_endpoint_db.enrich_installed,
        plan.plugin,
        device_id,
    )


@router.delete("/installed/{installed_id}", status_code=status.HTTP_204_NO_CONTENT)
async def uninstall_installed_plugin(
    installed_id: int,
    device_id: str | None = None,
    current_user: User = Depends(security.get_current_user),
) -> None:
    """Uninstall a user-scoped Claude Code plugin.

    Account-level uninstall is authoritative. Device sync is best-effort: a
    rejected or offline device must not leave the marketplace UI stuck on an
    installed / sync-failed state after the Kind row is already inactive.
    """
    user_id = current_user.id
    del current_user
    await run_sync_in_executor(
        plugin_endpoint_db.begin_uninstall,
        user_id,
        installed_id,
    )
    result = await _sync_global_capabilities(
        user_id,
        required_device_id=device_id,
        required_installed_kind_id=installed_id,
        expect_installed=False,
        require_device_success=False,
    )
    await run_sync_in_executor(
        plugin_endpoint_db.finalize_uninstall,
        user_id,
        installed_id,
        result,
    )


async def _ensure_installed_plugin_on_device(
    *,
    user_id: int,
    device_id: str | None,
    installed_id: int,
    previous: DeviceCapabilitySyncResponse | None = None,
    manual_retry: bool = False,
) -> DeviceCapabilitySyncResponse | None:
    """Retry a single-plugin merge when the global replace left the device short."""
    if not device_id:
        return previous
    should_retry = await run_sync_in_executor(
        plugin_endpoint_db.should_retry_device_install,
        device_id,
        installed_id,
        manual_retry,
    )
    if not should_retry:
        return previous
    try:
        merge_sync = (
            await device_capability_sync_service.sync_installed_plugin_to_device(
                user_id=user_id,
                device_id=device_id,
                installed_plugin_id=installed_id,
            )
        )
    except (
        DeviceCapabilitySyncError,
        DeviceCapabilityResolutionError,
        Exception,
    ) as exc:
        logger.warning(
            "Single-plugin device sync failed after install: user_id=%s device_id=%s installed_id=%s error=%s",
            user_id,
            device_id,
            installed_id,
            exc,
        )
        return previous
    await run_sync_in_executor(
        plugin_endpoint_db.record_merge_sync,
        user_id,
        merge_sync,
    )
    return merge_sync


async def _sync_global_capabilities(
    user_id: int,
    *,
    required_device_id: str | None = None,
    required_installed_kind_id: int | None = None,
    expect_installed: bool = True,
    require_device_success: bool = True,
) -> DeviceCapabilitySyncResponse:
    result = await device_capability_sync_service.sync_user_global_capabilities(
        user_id=user_id,
    )
    logger.info(
        "Global capability sync after plugin change completed: user_id=%s synced=%s failed=%s skipped=%s",
        user_id,
        result.synced,
        result.failed,
        result.skipped,
    )
    materialization_matches = await run_sync_in_executor(
        plugin_endpoint_db.record_global_sync,
        user_id,
        result,
        required_device_id,
        required_installed_kind_id,
        expect_installed,
    )
    required_result = next(
        (item for item in result.results if item.device_id == required_device_id),
        None,
    )
    required_device_failed = bool(
        required_device_id and (not required_result or not required_result.success)
    )
    required_materialization_failed = not materialization_matches
    if require_device_success and (
        required_device_failed or required_materialization_failed
    ):
        projected_results = await dump_models(result.results)
        raise HTTPException(
            status_code=502,
            detail={
                "code": "PLUGIN_DEVICE_SYNC_FAILED",
                "message": "Plugin saved but one or more devices failed to synchronize",
                "results": projected_results,
            },
        )
    if not require_device_success and (
        required_device_failed or required_materialization_failed
    ):
        logger.warning(
            "Device sync incomplete after plugin uninstall: user_id=%s device_id=%s installed_kind_id=%s",
            user_id,
            required_device_id,
            required_installed_kind_id,
        )
    return result


def _can_publish(*, user_id: int, user_role: str) -> bool:
    return bool(
        user_role == "admin"
        or settings.PLUGIN_PUBLISH_ENABLED
        or user_id in settings.PLUGIN_PUBLISH_USER_IDS
    )


def _ensure_publish_allowed(*, user_id: int, user_role: str) -> None:
    if not _can_publish(user_id=user_id, user_role=user_role):
        raise HTTPException(status_code=403, detail="Plugin publishing is not enabled")


@router.post(
    "/submissions/init",
    response_model=PluginSubmissionInitResponse,
    status_code=status.HTTP_201_CREATED,
)
async def init_plugin_submission(
    request: PluginSubmissionInitRequest,
    auth: PluginSubmissionAuth = Depends(_get_plugin_submission_auth),
) -> PluginSubmissionInitResponse:
    visibility = request.visibility or (
        "personal" if request.purpose == "restricted_share" else "workspace"
    )
    if visibility in {"workspace", "public"}:
        _ensure_publish_allowed(user_id=auth.user_id, user_role=auth.user_role)
    try:
        return await run_sync_in_executor(
            plugin_endpoint_db.init_submission,
            auth.user_id,
            request,
            auth.task_token,
        )
    except PluginPackageStorageError as exc:
        raise HTTPException(
            status_code=503, detail="Plugin package storage unavailable"
        ) from exc


@router.post(
    "/submissions/{submission_id}/complete",
    response_model=PluginSubmissionCompleteResponse,
)
async def complete_plugin_submission(
    submission_id: int,
    auth: PluginSubmissionAuth = Depends(_get_plugin_submission_auth),
) -> PluginSubmissionCompleteResponse:
    try:
        return await run_sync_in_executor(
            plugin_endpoint_db.complete_submission,
            submission_id,
            auth.user_id,
            auth.task_token,
            _can_publish(user_id=auth.user_id, user_role=auth.user_role),
        )
    except PluginPackageStorageError as exc:
        raise HTTPException(
            status_code=503, detail="Plugin package storage unavailable"
        ) from exc


@router.post(
    "/submissions/{submission_id}/cancel",
    response_model=PluginSubmissionItem,
)
async def cancel_plugin_submission(
    submission_id: int,
    auth: PluginSubmissionAuth = Depends(_get_plugin_submission_auth),
) -> PluginSubmissionItem:
    return await run_sync_in_executor(
        plugin_endpoint_db.cancel_submission,
        submission_id,
        auth.user_id,
        auth.task_token,
    )


@router.get("/submissions/{submission_id}", response_model=PluginSubmissionItem)
async def get_plugin_submission(
    submission_id: int,
    auth: PluginSubmissionAuth = Depends(_get_plugin_submission_auth),
) -> PluginSubmissionItem:
    return await run_sync_in_executor(
        plugin_endpoint_db.get_submission,
        submission_id,
        auth.user_id,
        auth.user_role,
        auth.task_token,
    )
