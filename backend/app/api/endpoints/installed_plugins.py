# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import io
import logging
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.core.config import settings
from app.db.session import get_db_session
from app.models.plugin_marketplace import Plugin, PluginDeviceInstallation
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
from app.services.device.capability_sync_service import (
    DeviceCapabilityResolutionError,
    DeviceCapabilitySyncError,
    device_capability_sync_service,
)
from app.services.installed_plugin_service import installed_plugin_service
from app.services.plugin_device_installation_service import (
    plugin_device_installation_service,
)
from app.services.plugin_marketplace_service import plugin_marketplace_service
from app.services.plugin_package_parser import MAX_PLUGIN_PACKAGE_SIZE_BYTES
from app.services.plugin_package_storage import PluginPackageStorageError

router = APIRouter(tags=["plugins"])
logger = logging.getLogger(__name__)
PLUGIN_UPLOAD_CHUNK_SIZE_BYTES = 1024 * 1024


@router.get("/installed", response_model=InstalledPluginListResponse)
def list_installed_plugins(
    device_id: str | None = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> InstalledPluginListResponse:
    """List Claude Code plugins installed by the current user."""
    # Keep list read-only. Catalog repair runs on install/sync paths instead of
    # every marketplace open.
    return plugin_marketplace_service.enrich_installed_list(
        db,
        installed_plugin_service.list_installed_plugins(
            db=db,
            user_id=current_user.id,
        ),
        device_id=device_id,
    )


@router.post(
    "/installed/auto-update-batch",
    response_model=PluginAutoUpdateBatchResponse,
)
def auto_update_installed_plugins(
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> PluginAutoUpdateBatchResponse:
    """Advance one bounded batch of cloud marketplace plugin installations."""
    return plugin_marketplace_service.auto_update_batch(
        db,
        user_id=current_user.id,
    )


@router.post("/installed/sync-device", response_model=PluginDeviceSyncResponse)
async def sync_installed_plugins_to_device(
    device_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> PluginDeviceSyncResponse:
    """Push account desired plugins to one device and refresh device rows."""
    normalized_device_id = device_id.strip()
    if not normalized_device_id:
        raise HTTPException(status_code=400, detail="device_id is required")

    # Repair stale catalog refs before building desired state / pushing packages.
    # Close the request session before awaiting the device round-trip so the
    # connection is not held for the Socket.IO acknowledgement timeout.
    plugin_marketplace_service.reconcile_stale_installed_catalog_refs(
        db, user_id=current_user.id
    )
    pending_count = plugin_device_installation_service.ensure_pending_for_device(
        db,
        user_id=current_user.id,
        device_id=normalized_device_id,
        reset_failed=True,
    )
    payload = device_capability_sync_service.build_desired_capabilities(
        db,
        user_id=current_user.id,
    )
    db.close()
    result = await device_capability_sync_service.sync_device_payload(
        user_id=current_user.id,
        device_id=normalized_device_id,
        payload=payload,
    )
    with get_db_session() as record_db:
        plugin_device_installation_service.record_device_sync_result(
            record_db,
            user_id=current_user.id,
            result=result,
        )
    mode = str(payload.get("mode") or "replace")
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
        current_user.id,
        normalized_device_id,
        pending_count,
        result.success,
    )
    return PluginDeviceSyncResponse(
        deviceId=normalized_device_id,
        pendingCount=pending_count,
        sync=sync,
    )


@router.get("/capabilities", response_model=PluginMarketplaceCapabilities)
def get_plugin_marketplace_capabilities(
    current_user: User = Depends(security.get_current_user),
) -> PluginMarketplaceCapabilities:
    return PluginMarketplaceCapabilities(
        canPublish=_can_publish(current_user),
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
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> InstalledPlugin:
    """Upload and install a Claude Code plugin ZIP package."""
    if current_user.role != "admin" or not settings.PLUGIN_LEGACY_UPLOAD_ENABLED:
        raise HTTPException(
            status_code=410,
            detail="Direct cloud upload is retired; create locally or publish a submission",
        )
    logger.info(
        "Plugin upload requested: user_id=%s filename=%s enabled=%s",
        current_user.id,
        file.filename,
        enabled,
    )
    content = await _read_plugin_upload(file)
    installed = installed_plugin_service.upload_plugin(
        db=db,
        user_id=current_user.id,
        package_bytes=content,
        filename=file.filename or "plugin.zip",
        enabled=enabled,
    )
    await _sync_global_capabilities(db, current_user.id)
    return installed


@router.get("/marketplace", response_model=PluginMarketplaceListResponse)
def list_marketplace_plugins(
    q: str | None = None,
    source: str | None = None,
    listing_type: str | None = None,
    device_id: str | None = None,
    db: Session = Depends(get_db),
    current_user: User | None = Depends(security.get_current_user_optional),
) -> PluginMarketplaceListResponse:
    """List Codex-compatible plugins published to the Wegent marketplace.

    This endpoint supports both authenticated and unauthenticated access:
    - Authenticated users see installation status and device-specific info
    - Unauthenticated users see all available plugins without installation status
    """
    return plugin_marketplace_service.list_plugins(
        db,
        user_id=current_user.id if current_user else None,
        query=q,
        source=source,
        listing_type=listing_type,
        device_id=device_id,
    )


@router.get("/marketplace/{plugin_id}", response_model=PluginMarketplaceItem)
def get_marketplace_plugin(
    plugin_id: int,
    device_id: str | None = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> PluginMarketplaceItem:
    return plugin_marketplace_service.get_plugin(
        db,
        plugin_id=plugin_id,
        user_id=current_user.id,
        device_id=device_id,
    )


@router.get(
    "/marketplace/{plugin_id}/releases", response_model=PluginReleaseListResponse
)
def list_marketplace_plugin_releases(
    plugin_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> PluginReleaseListResponse:
    return plugin_marketplace_service.list_releases(
        db, plugin_id=plugin_id, user_id=current_user.id
    )


@router.get(
    "/marketplace/{plugin_id}/access",
    response_model=PluginAccessResponse,
)
def get_marketplace_plugin_access(
    plugin_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> PluginAccessResponse:
    return plugin_marketplace_service.get_plugin_access(
        db,
        plugin_id=plugin_id,
        user_id=current_user.id,
    )


@router.put(
    "/marketplace/{plugin_id}/access",
    response_model=PluginAccessResponse,
)
async def update_marketplace_plugin_access(
    plugin_id: int,
    request: PluginAccessUpdateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> PluginAccessResponse:
    access, revoked_installs = plugin_marketplace_service.update_plugin_access(
        db,
        plugin_id=plugin_id,
        user_id=current_user.id,
        request=request,
    )
    for recipient_user_id, installed_id in revoked_installs:
        try:
            plugin_device_installation_service.mark_uninstalling(
                db,
                user_id=recipient_user_id,
                installed_kind_id=installed_id,
            )
            result = await _sync_global_capabilities(
                db,
                recipient_user_id,
                required_installed_kind_id=installed_id,
                expect_installed=False,
            )
            plugin_device_installation_service.record_uninstall_response(
                db,
                user_id=recipient_user_id,
                installed_kind_id=installed_id,
                response=result,
            )
        except Exception:
            db.rollback()
            logger.exception(
                "Plugin share revocation sync failed: plugin_id=%s user_id=%s",
                plugin_id,
                recipient_user_id,
            )
    access.revocationPendingCount = len(revoked_installs)
    return access


@router.post(
    "/marketplace/{plugin_id}/copy",
    response_model=PluginCopyResponse,
)
def copy_marketplace_plugin(
    plugin_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> PluginCopyResponse:
    try:
        return plugin_marketplace_service.plugin_copy_descriptor(
            db,
            plugin_id=plugin_id,
            user_id=current_user.id,
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
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> PluginMarketplaceInstallResponse:
    """Install a marketplace plugin for the current user.

    Account Kind creation is authoritative. Global device sync is best-effort:
    a full replace can fail because of an unrelated plugin while the new install
    is already desired; do not 502 and leave the marketplace UI stuck.
    """
    plugin = plugin_marketplace_service.install(
        db,
        user_id=current_user.id,
        plugin_id=marketplace_id,
        release_id=release_id,
    )
    installed_id = int(plugin.metadata["labels"]["id"])
    if plugin.spec.releaseId is not None:
        await plugin_device_installation_service.ensure_pending_for_all_devices(
            db,
            user_id=current_user.id,
            installed_kind_id=installed_id,
            desired_release_id=plugin.spec.releaseId,
        )
    sync = await _sync_global_capabilities(
        db,
        current_user.id,
        required_device_id=device_id,
        required_installed_kind_id=installed_id,
        expect_installed=True,
        require_device_success=False,
    )
    sync = await _ensure_installed_plugin_on_device(
        db,
        user_id=current_user.id,
        device_id=device_id,
        installed_id=installed_id,
        previous=sync,
    )
    enriched = plugin_marketplace_service.enrich_installed_list(
        db,
        InstalledPluginListResponse(items=[plugin]),
        device_id=device_id,
    )
    return PluginMarketplaceInstallResponse(plugin=enriched.items[0], sync=sync)


@router.post(
    "/builtin/{plugin_key}/ensure-installed",
    response_model=PluginMarketplaceInstallResponse,
)
async def ensure_builtin_plugin_installed(
    plugin_key: str,
    request: BuiltinPluginInstallRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> PluginMarketplaceInstallResponse:
    """Install a bundled plugin from the v2 marketplace catalog."""
    item = db.query(Plugin).filter(Plugin.slug == plugin_key).first()
    if not item:
        return await _ensure_legacy_builtin_plugin_installed(
            plugin_key=plugin_key,
            request=request,
            db=db,
            user_id=current_user.id,
        )
    plugin = plugin_marketplace_service.install(
        db,
        user_id=current_user.id,
        plugin_id=item.id,
    )
    installed_id = int(plugin.metadata["labels"]["id"])
    if plugin.spec.releaseId is not None:
        await plugin_device_installation_service.ensure_pending_for_all_devices(
            db,
            user_id=current_user.id,
            installed_kind_id=installed_id,
            desired_release_id=plugin.spec.releaseId,
        )
    sync = await _sync_global_capabilities(
        db,
        current_user.id,
        required_device_id=request.device_id,
        required_installed_kind_id=installed_id,
        expect_installed=True,
        require_device_success=False,
    )
    sync = await _ensure_installed_plugin_on_device(
        db,
        user_id=current_user.id,
        device_id=request.device_id,
        installed_id=installed_id,
        previous=sync,
    )
    enriched = plugin_marketplace_service.enrich_installed_list(
        db,
        InstalledPluginListResponse(items=[plugin]),
        device_id=request.device_id,
    )
    return PluginMarketplaceInstallResponse(plugin=enriched.items[0], sync=sync)


async def _ensure_legacy_builtin_plugin_installed(
    *,
    plugin_key: str,
    request: BuiltinPluginInstallRequest,
    db: Session,
    user_id: int,
) -> PluginMarketplaceInstallResponse:
    plugin = installed_plugin_service.install_builtin_plugin(
        db=db,
        user_id=user_id,
        plugin_key=plugin_key,
    )
    if request.device_id is None:
        sync = await _sync_global_capabilities(db, user_id)
        return PluginMarketplaceInstallResponse(plugin=plugin, sync=sync)

    installed_id = int(plugin.metadata["labels"]["id"])
    try:
        sync = await device_capability_sync_service.sync_installed_plugin_to_device(
            db,
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
def download_installed_plugin(
    installed_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user_jwt_apikey_tasktoken),
) -> StreamingResponse:
    """Download a user's installed plugin package for local executor sync."""
    try:
        package_bytes, filename = (
            plugin_marketplace_service.release_package_for_install(
                db, user_id=current_user.id, installed_id=installed_id
            )
        )
    except HTTPException as exc:
        if exc.status_code != 404:
            raise
        package_bytes, filename = installed_plugin_service.package_data_for_download(
            db=db,
            user_id=current_user.id,
            installed_id=installed_id,
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
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> InstalledPlugin:
    """Update an installed plugin's enabled state or display metadata."""
    if request.releaseId is not None:
        installed = plugin_marketplace_service.update_release(
            db,
            user_id=current_user.id,
            installed_id=installed_id,
            release_id=request.releaseId,
        )
    else:
        installed = installed_plugin_service.update_installed_plugin(
            db=db,
            user_id=current_user.id,
            installed_id=installed_id,
            request=request,
        )
    if installed.spec.releaseId is not None:
        await plugin_device_installation_service.ensure_pending_for_all_devices(
            db,
            user_id=current_user.id,
            installed_kind_id=installed_id,
            desired_release_id=installed.spec.releaseId,
        )
    await _sync_global_capabilities(
        db,
        current_user.id,
        required_device_id=device_id,
        required_installed_kind_id=installed_id,
        expect_installed=True,
        require_device_success=False,
    )
    await _ensure_installed_plugin_on_device(
        db,
        user_id=current_user.id,
        device_id=device_id,
        installed_id=installed_id,
    )
    return plugin_marketplace_service.enrich_installed_list(
        db,
        InstalledPluginListResponse(items=[installed]),
        device_id=device_id,
    ).items[0]


@router.delete("/installed/{installed_id}", status_code=status.HTTP_204_NO_CONTENT)
async def uninstall_installed_plugin(
    installed_id: int,
    device_id: str | None = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> None:
    """Uninstall a user-scoped Claude Code plugin.

    Account-level uninstall is authoritative. Device sync is best-effort: a
    rejected or offline device must not leave the marketplace UI stuck on an
    installed / sync-failed state after the Kind row is already inactive.
    """
    plugin_device_installation_service.mark_uninstalling(
        db, user_id=current_user.id, installed_kind_id=installed_id
    )
    try:
        installed_plugin_service.uninstall_installed_plugin(
            db=db,
            user_id=current_user.id,
            installed_id=installed_id,
        )
    except HTTPException as exc:
        if exc.status_code != status.HTTP_404_NOT_FOUND:
            raise
        # Idempotent: Kind may already be inactive after a prior partial uninstall.
    result = await _sync_global_capabilities(
        db,
        current_user.id,
        required_device_id=device_id,
        required_installed_kind_id=installed_id,
        expect_installed=False,
        require_device_success=False,
    )
    plugin_device_installation_service.record_uninstall_response(
        db,
        user_id=current_user.id,
        installed_kind_id=installed_id,
        response=result,
    )
    plugin_device_installation_service.clear_installations(
        db,
        user_id=current_user.id,
        installed_kind_id=installed_id,
    )


async def _ensure_installed_plugin_on_device(
    db: Session,
    *,
    user_id: int,
    device_id: str | None,
    installed_id: int,
    previous: DeviceCapabilitySyncResponse | None = None,
) -> DeviceCapabilitySyncResponse | None:
    """Retry a single-plugin merge when the global replace left the device short."""
    if not device_id:
        return previous
    device_row = (
        db.query(PluginDeviceInstallation)
        .filter(
            PluginDeviceInstallation.installed_kind_id == installed_id,
            PluginDeviceInstallation.device_id == device_id,
        )
        .first()
    )
    if device_row and device_row.state == "installed":
        return previous
    try:
        merge_sync = (
            await device_capability_sync_service.sync_installed_plugin_to_device(
                db,
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
    plugin_device_installation_service.record_sync_response(
        db, user_id=user_id, response=merge_sync
    )
    return merge_sync


async def _sync_global_capabilities(
    db: Session,
    user_id: int,
    *,
    required_device_id: str | None = None,
    required_installed_kind_id: int | None = None,
    expect_installed: bool = True,
    require_device_success: bool = True,
) -> DeviceCapabilitySyncResponse:
    result = await device_capability_sync_service.sync_user_global_capabilities(
        db,
        user_id=user_id,
    )
    logger.info(
        "Global capability sync after plugin change completed: user_id=%s synced=%s failed=%s skipped=%s",
        user_id,
        result.synced,
        result.failed,
        result.skipped,
    )
    plugin_device_installation_service.record_sync_response(
        db, user_id=user_id, response=result
    )
    required_result = next(
        (item for item in result.results if item.device_id == required_device_id),
        None,
    )
    required_device_failed = bool(
        required_device_id and (not required_result or not required_result.success)
    )
    required_materialization_failed = False
    if required_device_id and required_installed_kind_id is not None:
        device_row = (
            db.query(PluginDeviceInstallation)
            .filter(
                PluginDeviceInstallation.installed_kind_id
                == required_installed_kind_id,
                PluginDeviceInstallation.device_id == required_device_id,
            )
            .first()
        )
        materialized = bool(device_row and device_row.state == "installed")
        required_materialization_failed = materialized != expect_installed
    if require_device_success and (
        required_device_failed or required_materialization_failed
    ):
        raise HTTPException(
            status_code=502,
            detail={
                "code": "PLUGIN_DEVICE_SYNC_FAILED",
                "message": "Plugin saved but one or more devices failed to synchronize",
                "results": [item.model_dump() for item in result.results],
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


def _can_publish(current_user: User) -> bool:
    return bool(
        current_user.role == "admin"
        or settings.PLUGIN_PUBLISH_ENABLED
        or current_user.id in settings.PLUGIN_PUBLISH_USER_IDS
    )


def _ensure_publish_allowed(current_user: User) -> None:
    if not _can_publish(current_user):
        raise HTTPException(status_code=403, detail="Plugin publishing is not enabled")


@router.post(
    "/submissions/init",
    response_model=PluginSubmissionInitResponse,
    status_code=status.HTTP_201_CREATED,
)
def init_plugin_submission(
    request: PluginSubmissionInitRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> PluginSubmissionInitResponse:
    visibility = request.visibility or (
        "personal" if request.purpose == "restricted_share" else "workspace"
    )
    if visibility in {"workspace", "public"}:
        _ensure_publish_allowed(current_user)
    try:
        return plugin_marketplace_service.init_submission(
            db, user_id=current_user.id, request=request
        )
    except PluginPackageStorageError as exc:
        raise HTTPException(
            status_code=503, detail="Plugin package storage unavailable"
        ) from exc


@router.post(
    "/submissions/{submission_id}/complete",
    response_model=PluginSubmissionCompleteResponse,
)
def complete_plugin_submission(
    submission_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> PluginSubmissionCompleteResponse:
    existing = plugin_marketplace_service.get_submission(
        db,
        user_id=current_user.id,
        submission_id=submission_id,
    )
    if existing.purpose == "marketplace_publish":
        _ensure_publish_allowed(current_user)
    try:
        item = plugin_marketplace_service.complete_submission(
            db, user_id=current_user.id, submission_id=submission_id
        )
    except PluginPackageStorageError as exc:
        raise HTTPException(
            status_code=503, detail="Plugin package storage unavailable"
        ) from exc
    plugin = None
    if item.status in {"approved", "pending"}:
        try:
            plugin = plugin_marketplace_service.get_plugin(
                db,
                plugin_id=item.pluginId,
                user_id=current_user.id,
            )
        except HTTPException:
            plugin = None
    return PluginSubmissionCompleteResponse(submission=item, plugin=plugin)


@router.post(
    "/submissions/{submission_id}/cancel",
    response_model=PluginSubmissionItem,
)
def cancel_plugin_submission(
    submission_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> PluginSubmissionItem:
    return plugin_marketplace_service.cancel_submission(
        db,
        user_id=current_user.id,
        submission_id=submission_id,
    )


@router.get("/submissions/{submission_id}", response_model=PluginSubmissionItem)
def get_plugin_submission(
    submission_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> PluginSubmissionItem:
    return plugin_marketplace_service.get_submission(
        db,
        user_id=current_user.id,
        submission_id=submission_id,
        is_admin=current_user.role == "admin",
    )
