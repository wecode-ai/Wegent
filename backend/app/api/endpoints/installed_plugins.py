# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import io
import logging
from dataclasses import dataclass
from urllib.parse import quote

from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    File,
    Form,
    HTTPException,
    Query,
    Request,
    UploadFile,
    status,
)
from fastapi.responses import Response, StreamingResponse
from jose import JWTError, jwt
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.api.marketplace_upload import read_marketplace_package
from app.core import security
from app.core.config import settings
from app.models.plugin_marketplace import PluginDeviceInstallation
from app.models.subtask import SubtaskStatus
from app.models.task import TaskResource
from app.models.user import User
from app.schemas.device import DeviceCapabilitySyncResponse
from app.schemas.installed_plugin import (
    BuiltinPluginInstallRequest,
    InstalledPlugin,
    InstalledPluginListResponse,
    InstalledPluginUpdateRequest,
    PluginAccessResponse,
    PluginAccessUpdateRequest,
    PluginCopyResponse,
    PluginDeleteImpactResponse,
    PluginDeleteRequest,
    PluginDeleteResponse,
    PluginDeviceReportRequest,
    PluginDeviceReportResponse,
    PluginDeviceSyncResponse,
    PluginMarketplaceInstallResponse,
    PluginMarketplaceItem,
    PluginReleaseListResponse,
    PluginSubmissionCompleteResponse,
    PluginSubmissionInitRequest,
    PluginSubmissionInitResponse,
    PluginSubmissionItem,
)
from app.services.auth.task_token import TaskTokenInfo, verify_task_token
from app.services.device.capability_sync_service import device_capability_sync_service
from app.services.device.plugin_reconciliation import reconcile_device_plugins
from app.services.device.plugin_removal_sync import sync_pending_plugin_removals
from app.services.installed_plugin_service import installed_plugin_service
from app.services.marketplace_submission_upload import (
    InvalidMarketplaceSubmissionUploadToken,
    verify_marketplace_submission_upload_token,
)
from app.services.plugin_device_installation_service import (
    plugin_device_installation_service,
)
from app.services.plugin_device_sync import (
    sync_global_capabilities,
    sync_plugin_after_change,
)
from app.services.plugin_installation_operations import (
    install_builtin_account_plugin,
    prepare_device_plugin_sync,
    uninstall_account_plugin,
    update_account_plugin,
)
from app.services.plugin_marketplace_service import plugin_marketplace_service
from app.services.plugin_package_parser import MAX_PLUGIN_PACKAGE_SIZE_BYTES
from app.services.plugin_package_storage import PluginPackageStorageError
from app.services.plugin_write_coordination import (
    get_plugin_db,
)
from app.services.plugin_write_operations import run_plugin_operation
from app.stores.tasks import subtask_store, task_store
from shared.telemetry.decorators import trace_async

router = APIRouter(tags=["plugins"])
logger = logging.getLogger(__name__)
PLUGIN_UPLOAD_CHUNK_SIZE_BYTES = 1024 * 1024
ACTIVE_PLUGIN_SUBMISSION_SUBTASK_STATUSES = (
    SubtaskStatus.PENDING,
    SubtaskStatus.RUNNING,
    SubtaskStatus.PENDING_CONFIRMATION,
)


@dataclass(frozen=True)
class PluginSubmissionAuth:
    user: User
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


def _get_plugin_submission_auth(
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user_jwt_apikey_tasktoken),
) -> PluginSubmissionAuth:
    """Restrict task-token submission access to its live Task execution."""
    if request.headers.get("X-API-Key", "").strip():
        return PluginSubmissionAuth(user=current_user)

    token_info = _task_token_from_authorization(
        request.headers.get("Authorization", "")
    )
    if token_info is None:
        return PluginSubmissionAuth(user=current_user)

    task = task_store.get_by_id_for_update(
        db,
        task_id=token_info.task_id,
        owner_user_id=current_user.id,
    )
    subtask = subtask_store.get_basic_by_id_for_update(
        db,
        subtask_id=token_info.subtask_id,
        owner_user_id=current_user.id,
    )
    if (
        task is None
        or task.kind != "Task"
        or task.is_active not in TaskResource.is_active_query()
        or subtask is None
        or subtask.task_id != token_info.task_id
        or subtask.user_id != current_user.id
        or subtask.status not in ACTIVE_PLUGIN_SUBMISSION_SUBTASK_STATUSES
    ):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Task token is no longer active",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return PluginSubmissionAuth(user=current_user, task_token=token_info)


def _ensure_submission_matches_task_token(
    db: Session,
    *,
    auth: PluginSubmissionAuth,
    submission_id: int,
) -> None:
    if auth.task_token is None:
        return
    plugin_marketplace_service.ensure_submission_task_binding(
        db,
        user_id=auth.user.id,
        submission_id=submission_id,
        task_id=auth.task_token.task_id,
        subtask_id=auth.task_token.subtask_id,
    )


@router.post("/installed/sync-device", response_model=PluginDeviceSyncResponse)
async def sync_installed_plugins_to_device(
    device_id: str,
    reconcile: bool = False,
    db: Session = Depends(get_plugin_db),
    current_user: User = Depends(security.get_current_user),
) -> PluginDeviceSyncResponse:
    """Push account desired plugins to one device and refresh device rows."""
    normalized_device_id = device_id.strip()
    if not normalized_device_id:
        raise HTTPException(status_code=400, detail="device_id is required")
    user_id = current_user.id

    if reconcile:
        db.close()
        return await reconcile_device_plugins(user_id, normalized_device_id)

    db.close()
    pending_count = await run_plugin_operation(
        prepare_device_plugin_sync,
        user_id=user_id,
        device_id=normalized_device_id,
    )
    result = await device_capability_sync_service.sync_current_device_capabilities(
        user_id=user_id,
        device_id=normalized_device_id,
    )
    await run_plugin_operation(
        plugin_device_installation_service.record_device_sync_result,
        user_id=user_id,
        result=result,
    )
    errors = list(result.errors or [])
    if result.error:
        errors.append({"device_id": result.device_id, "error": result.error})
    sync = DeviceCapabilitySyncResponse(
        success=bool(result.success),
        device_id=result.device_id,
        mode="replace",
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
        pending_count,
        result.success,
    )
    return PluginDeviceSyncResponse(
        deviceId=normalized_device_id,
        pendingCount=pending_count,
        sync=sync,
    )


@router.post(
    "/installed/{installed_id}/sync-device",
    response_model=PluginDeviceSyncResponse,
)
async def sync_installed_plugin_to_device(
    installed_id: int,
    device_id: str,
    db: Session = Depends(get_plugin_db),
    current_user: User = Depends(security.get_current_user),
) -> PluginDeviceSyncResponse:
    """Merge one installed plugin without changing unrelated device state."""
    normalized_device_id = device_id.strip()
    if not normalized_device_id:
        raise HTTPException(status_code=400, detail="device_id is required")
    user_id = current_user.id
    db.close()
    pending_count = await run_plugin_operation(
        prepare_device_plugin_sync,
        user_id=user_id,
        device_id=normalized_device_id,
        installed_id=installed_id,
    )
    try:
        sync = (
            await device_capability_sync_service.sync_installed_plugin_to_device_result(
                db,
                user_id=user_id,
                device_id=normalized_device_id,
                installed_plugin_id=installed_id,
            )
        )
    finally:
        db.close()
    await run_plugin_operation(
        plugin_device_installation_service.record_plugin_sync_response,
        user_id=user_id,
        installed_kind_id=installed_id,
        response=sync,
    )
    return PluginDeviceSyncResponse(
        deviceId=normalized_device_id,
        pendingCount=pending_count,
        sync=sync,
    )


@router.post("/installed/report-device", response_model=PluginDeviceReportResponse)
def report_installed_plugins_on_device(
    payload: PluginDeviceReportRequest,
    device_id: str,
    db: Session = Depends(get_plugin_db),
    current_user: User = Depends(security.get_current_user),
) -> PluginDeviceReportResponse:
    """Acknowledge locally present plugins on one device without pushing packages."""
    normalized_device_id = device_id.strip()
    if not normalized_device_id:
        raise HTTPException(status_code=400, detail="device_id is required")
    acknowledged_ids = plugin_device_installation_service.acknowledge_local_installs(
        db,
        user_id=current_user.id,
        device_id=normalized_device_id,
        reported_plugins=payload.plugins,
    )
    logger.info(
        "Device plugin status reported: user_id=%s device_id=%s acknowledged=%s",
        current_user.id,
        normalized_device_id,
        len(acknowledged_ids),
    )
    return PluginDeviceReportResponse(
        deviceId=normalized_device_id,
        acknowledgedCount=len(acknowledged_ids),
        acknowledgedInstalledPluginIds=acknowledged_ids,
    )


@router.post(
    "/upload",
    response_model=InstalledPlugin,
    status_code=status.HTTP_201_CREATED,
)
async def upload_plugin(
    file: UploadFile = File(...),
    enabled: bool = Form(True),
    db: Session = Depends(get_plugin_db),
    current_user: User = Depends(security.get_current_user),
) -> InstalledPlugin:
    """Upload and install a Claude Code plugin ZIP package."""
    if current_user.role != "admin" or not settings.PLUGIN_LEGACY_UPLOAD_ENABLED:
        raise HTTPException(
            status_code=410,
            detail=(
                "Direct cloud upload is retired; create locally or publish a submission"
            ),
        )
    logger.info(
        "Plugin upload requested: user_id=%s filename=%s enabled=%s",
        current_user.id,
        file.filename,
        enabled,
    )
    content = await _read_plugin_upload(file)
    user_id = current_user.id
    db.close()
    installed = await run_plugin_operation(
        installed_plugin_service.upload_plugin,
        user_id=user_id,
        package_bytes=content,
        filename=file.filename or "plugin.zip",
        enabled=enabled,
    )
    await sync_global_capabilities(
        db,
        user_id,
        required_installed_kind_id=int(installed.metadata["labels"]["id"]),
        require_device_success=False,
    )
    return installed


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
    db: Session = Depends(get_plugin_db),
    current_user: User = Depends(security.get_current_user),
) -> PluginAccessResponse:
    user_id = current_user.id
    db.close()
    access, revoked_installs = await run_plugin_operation(
        plugin_marketplace_service.update_plugin_access,
        plugin_id=plugin_id,
        user_id=user_id,
        request=request,
    )
    for recipient_user_id, installed_id in revoked_installs:
        try:
            await run_plugin_operation(
                plugin_device_installation_service.mark_uninstalling,
                user_id=recipient_user_id,
                installed_kind_id=installed_id,
            )
            result = await sync_global_capabilities(
                db,
                recipient_user_id,
                required_installed_kind_id=installed_id,
                expect_installed=False,
            )
            await run_plugin_operation(
                plugin_device_installation_service.record_uninstall_response,
                user_id=recipient_user_id,
                installed_kind_id=installed_id,
                response=result.model_copy(
                    update={
                        "results": [
                            item
                            for item in result.results
                            if item.desired_plugin_snapshot is None
                        ]
                    }
                ),
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


@router.get(
    "/marketplace/{plugin_id}/delete-impact",
    response_model=PluginDeleteImpactResponse,
)
def get_marketplace_plugin_delete_impact(
    plugin_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> PluginDeleteImpactResponse:
    return plugin_marketplace_service.get_personal_plugin_delete_impact(
        db,
        plugin_id=plugin_id,
        user_id=current_user.id,
    )


@router.delete(
    "/marketplace/{plugin_id}",
    response_model=PluginDeleteResponse,
)
async def delete_marketplace_plugin(
    plugin_id: int,
    request: PluginDeleteRequest,
    db: Session = Depends(get_plugin_db),
    current_user: User = Depends(security.get_current_user),
) -> PluginDeleteResponse:
    user_id = current_user.id
    db.close()
    installations = await run_plugin_operation(
        plugin_marketplace_service.delete_owned_personal_plugin,
        plugin_id=plugin_id,
        user_id=user_id,
        impact_revision=request.impactRevision,
        revoke_and_delete=request.revokeAndDelete,
    )
    for installation_user_id, installed_id in installations:
        try:
            await run_plugin_operation(
                plugin_device_installation_service.mark_uninstalling,
                user_id=installation_user_id,
                installed_kind_id=installed_id,
            )
            result = await sync_global_capabilities(
                db,
                installation_user_id,
                required_installed_kind_id=installed_id,
                expect_installed=False,
            )
            await run_plugin_operation(
                plugin_device_installation_service.record_uninstall_response,
                user_id=installation_user_id,
                installed_kind_id=installed_id,
                response=result.model_copy(
                    update={
                        "results": [
                            item
                            for item in result.results
                            if item.desired_plugin_snapshot is None
                        ]
                    }
                ),
            )
        except Exception:
            db.rollback()
            logger.exception(
                "Deleted plugin uninstall sync failed: plugin_id=%s user_id=%s",
                plugin_id,
                installation_user_id,
            )
    installation_ids = [installed_id for _, installed_id in installations]
    pending_device_count = 0
    if installation_ids:
        pending_device_count = (
            db.query(PluginDeviceInstallation.id)
            .filter(PluginDeviceInstallation.installed_kind_id.in_(installation_ids))
            .count()
        )
    return PluginDeleteResponse(pendingDeviceCount=pending_device_count)


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
    db: Session = Depends(get_plugin_db),
    current_user: User = Depends(security.get_current_user),
) -> PluginMarketplaceInstallResponse:
    """Save the authoritative install and synchronize the affected plugin."""
    user_id = current_user.id
    db.close()
    plugin = await run_plugin_operation(
        plugin_marketplace_service.install,
        user_id=user_id,
        plugin_id=marketplace_id,
        release_id=release_id,
    )
    sync = await sync_plugin_after_change(
        db, user_id=user_id, installed=plugin, device_id=device_id
    )
    enriched = await run_plugin_operation(
        plugin_marketplace_service.enrich_installed_list,
        response=InstalledPluginListResponse(items=[plugin]),
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
    db: Session = Depends(get_plugin_db),
    current_user: User = Depends(security.get_current_user),
) -> PluginMarketplaceInstallResponse:
    """Install a bundled plugin from the v2 marketplace catalog."""
    user_id = current_user.id
    db.close()
    plugin = await run_plugin_operation(
        install_builtin_account_plugin, user_id=user_id, plugin_key=plugin_key
    )
    sync = await sync_plugin_after_change(
        db,
        user_id=user_id,
        installed=plugin,
        device_id=request.device_id,
        sync_current_device_only=plugin.spec.source.providerKey == "wegent-marketplace",
    )
    enriched = await run_plugin_operation(
        plugin_marketplace_service.enrich_installed_list,
        response=InstalledPluginListResponse(items=[plugin]),
        device_id=request.device_id,
    )
    return PluginMarketplaceInstallResponse(plugin=enriched.items[0], sync=sync)


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
    db: Session = Depends(get_plugin_db),
    current_user: User = Depends(security.get_current_user),
) -> InstalledPlugin:
    """Update an installed plugin's runtime state, metadata, or update policy."""
    user_id = current_user.id
    db.close()
    installed = await run_plugin_operation(
        update_account_plugin,
        user_id=user_id,
        installed_id=installed_id,
        request=request,
    )
    await sync_plugin_after_change(
        db,
        user_id=user_id,
        installed=installed,
        device_id=device_id,
        reset_failures=request.releaseId is not None,
    )
    enriched = await run_plugin_operation(
        plugin_marketplace_service.enrich_installed_list,
        response=InstalledPluginListResponse(items=[installed]),
        device_id=device_id,
    )
    return enriched.items[0]


@router.delete("/installed/{installed_id}", status_code=status.HTTP_204_NO_CONTENT)
@trace_async(
    tracer_name="backend.plugins", span_name="plugins.uninstall_account_plugin"
)
async def uninstall_installed_plugin(
    installed_id: int,
    background_tasks: BackgroundTasks,
    device_id: str | None = None,
    db: Session = Depends(get_plugin_db),
    current_user: User = Depends(security.get_current_user),
) -> None:
    """Commit account removal before asynchronously reconciling devices."""
    user_id = current_user.id
    db.close()
    await run_plugin_operation(
        uninstall_account_plugin, user_id=user_id, installed_id=installed_id
    )
    background_tasks.add_task(sync_pending_plugin_removals, user_id)


@router.post(
    "/submissions/init",
    response_model=PluginSubmissionInitResponse,
    status_code=status.HTTP_201_CREATED,
)
def init_plugin_submission(
    request: PluginSubmissionInitRequest,
    db: Session = Depends(get_db),
    auth: PluginSubmissionAuth = Depends(_get_plugin_submission_auth),
) -> PluginSubmissionInitResponse:
    current_user = auth.user
    visibility = request.visibility or (
        "personal" if request.purpose == "restricted_share" else "workspace"
    )
    if request.purpose != "restricted_share" or visibility != "personal":
        raise HTTPException(
            status_code=422,
            detail=(
                "Legacy submissions only support restricted personal sharing; "
                "use /plugins/publication-requests for enterprise publication"
            ),
        )
    try:
        return plugin_marketplace_service.init_submission(
            db,
            user_id=current_user.id,
            request=request,
            task_binding=(
                (auth.task_token.task_id, auth.task_token.subtask_id)
                if auth.task_token
                else None
            ),
        )
    except PluginPackageStorageError as exc:
        raise HTTPException(
            status_code=503, detail="Plugin package storage unavailable"
        ) from exc


@router.put("/submissions/{submission_id}/artifact", status_code=204)
@trace_async("upload_plugin_submission_artifact", "marketplace.api")
async def upload_plugin_submission_artifact(
    submission_id: int,
    request: Request,
    token: str = Query(..., description="Short-lived plugin upload token"),
    db: Session = Depends(get_db),
) -> Response:
    """Upload a ticketed plugin package through the Backend origin."""
    try:
        claims = verify_marketplace_submission_upload_token(
            token, expected_kind="plugin"
        )
    except InvalidMarketplaceSubmissionUploadToken as exc:
        raise HTTPException(
            status_code=403, detail="Invalid or expired plugin upload link"
        ) from exc
    if claims.submission_id != submission_id:
        raise HTTPException(
            status_code=403, detail="Invalid or expired plugin upload link"
        )

    package = await read_marketplace_package(
        request,
        max_bytes=MAX_PLUGIN_PACKAGE_SIZE_BYTES,
        resource_name="Plugin",
    )
    try:
        plugin_marketplace_service.upload_submission_package(
            db,
            user_id=claims.user_id,
            submission_id=submission_id,
            package=package,
        )
    except PluginPackageStorageError as exc:
        raise HTTPException(
            status_code=503, detail="Plugin package storage unavailable"
        ) from exc
    return Response(status_code=204)


@router.post(
    "/submissions/{submission_id}/complete",
    response_model=PluginSubmissionCompleteResponse,
)
def complete_plugin_submission(
    submission_id: int,
    db: Session = Depends(get_db),
    auth: PluginSubmissionAuth = Depends(_get_plugin_submission_auth),
) -> PluginSubmissionCompleteResponse:
    current_user = auth.user
    _ensure_submission_matches_task_token(db, auth=auth, submission_id=submission_id)
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
    auth: PluginSubmissionAuth = Depends(_get_plugin_submission_auth),
) -> PluginSubmissionItem:
    current_user = auth.user
    _ensure_submission_matches_task_token(db, auth=auth, submission_id=submission_id)
    return plugin_marketplace_service.cancel_submission(
        db,
        user_id=current_user.id,
        submission_id=submission_id,
    )


@router.get("/submissions/{submission_id}", response_model=PluginSubmissionItem)
def get_plugin_submission(
    submission_id: int,
    db: Session = Depends(get_db),
    auth: PluginSubmissionAuth = Depends(_get_plugin_submission_auth),
) -> PluginSubmissionItem:
    current_user = auth.user
    _ensure_submission_matches_task_token(db, auth=auth, submission_id=submission_id)
    return plugin_marketplace_service.get_submission(
        db,
        user_id=current_user.id,
        submission_id=submission_id,
        is_admin=current_user.role == "admin",
    )
