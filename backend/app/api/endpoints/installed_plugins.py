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
from app.models.user import User
from app.schemas.device import DeviceCapabilitySyncResponse
from app.schemas.installed_plugin import (
    BuiltinPluginInstallRequest,
    InstalledPlugin,
    InstalledPluginListResponse,
    InstalledPluginUpdateRequest,
    PluginMarketplaceInstallResponse,
    PluginMarketplaceListResponse,
    PluginMarketplacePublishResponse,
)
from app.services.device.capability_sync_service import (
    DeviceCapabilityResolutionError,
    DeviceCapabilitySyncError,
    device_capability_sync_service,
)
from app.services.installed_plugin_service import installed_plugin_service
from app.services.plugin_package_parser import MAX_PLUGIN_PACKAGE_SIZE_BYTES

router = APIRouter(tags=["plugins"])
logger = logging.getLogger(__name__)
PLUGIN_UPLOAD_CHUNK_SIZE_BYTES = 1024 * 1024


@router.get("/installed", response_model=InstalledPluginListResponse)
def list_installed_plugins(
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> InstalledPluginListResponse:
    """List plugins installed by the current user."""
    return installed_plugin_service.list_installed_plugins(
        db=db,
        user_id=current_user.id,
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
    """Upload and install a Codex or Claude Code plugin ZIP package."""
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
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> PluginMarketplaceListResponse:
    """List plugins published to the Wegent marketplace."""
    return installed_plugin_service.list_marketplace_plugins(
        db=db,
        user_id=current_user.id,
        query=q,
        source=source,
    )


@router.post(
    "/marketplace/publish",
    response_model=PluginMarketplacePublishResponse,
    status_code=status.HTTP_201_CREATED,
)
async def publish_marketplace_plugin(
    file: UploadFile = File(...),
    visibility: str = Form("workspace"),
    featured: bool = Form(False),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> PluginMarketplacePublishResponse:
    """Publish a Codex-compatible plugin ZIP package to the Wegent marketplace."""
    if visibility not in {"personal", "workspace", "public"}:
        raise HTTPException(status_code=400, detail="Invalid plugin visibility")
    content = await _read_plugin_upload(file)
    item = installed_plugin_service.publish_marketplace_plugin(
        db=db,
        user_id=current_user.id,
        package_bytes=content,
        filename=file.filename or "plugin.zip",
        visibility=visibility,
        featured=featured,
    )
    return PluginMarketplacePublishResponse(item=item)


@router.post(
    "/marketplace/{marketplace_id}/install",
    response_model=PluginMarketplaceInstallResponse,
)
async def install_marketplace_plugin(
    marketplace_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> PluginMarketplaceInstallResponse:
    """Install a marketplace plugin for the current user."""
    plugin = installed_plugin_service.install_marketplace_plugin(
        db=db,
        user_id=current_user.id,
        marketplace_id=marketplace_id,
    )
    await _sync_global_capabilities(db, current_user.id)
    return PluginMarketplaceInstallResponse(plugin=plugin)


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
    """Install a system plugin and synchronize it to available devices."""
    plugin = installed_plugin_service.install_builtin_plugin(
        db=db,
        user_id=current_user.id,
        plugin_key=plugin_key,
    )
    if request.device_id is None:
        sync = await _sync_global_capabilities(db, current_user.id)
        return PluginMarketplaceInstallResponse(plugin=plugin, sync=sync)

    installed_plugin_id = _installed_plugin_id(plugin)
    try:
        sync = await device_capability_sync_service.sync_installed_plugin_to_device(
            db,
            user_id=current_user.id,
            device_id=request.device_id,
            installed_plugin_id=installed_plugin_id,
        )
    except DeviceCapabilityResolutionError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
    except DeviceCapabilitySyncError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=str(exc),
        ) from exc
    return PluginMarketplaceInstallResponse(plugin=plugin, sync=sync)


def _installed_plugin_id(plugin: InstalledPlugin) -> int:
    labels = plugin.metadata.get("labels")
    raw_id = labels.get("id") if isinstance(labels, dict) else None
    try:
        return int(raw_id)
    except (TypeError, ValueError) as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Installed plugin identity is unavailable",
        ) from exc


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
    package_bytes, filename = installed_plugin_service.package_data_for_download(
        db=db,
        user_id=current_user.id,
        installed_id=installed_id,
    )
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
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> InstalledPlugin:
    """Update an installed plugin's enabled state or display metadata."""
    installed = installed_plugin_service.update_installed_plugin(
        db=db,
        user_id=current_user.id,
        installed_id=installed_id,
        request=request,
    )
    await _sync_global_capabilities(db, current_user.id)
    return installed


@router.delete("/installed/{installed_id}", status_code=status.HTTP_204_NO_CONTENT)
async def uninstall_installed_plugin(
    installed_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> None:
    """Uninstall a user-scoped plugin."""
    installed_plugin_service.uninstall_installed_plugin(
        db=db,
        user_id=current_user.id,
        installed_id=installed_id,
    )
    await _sync_global_capabilities(db, current_user.id)


async def _sync_global_capabilities(
    db: Session,
    user_id: int,
) -> DeviceCapabilitySyncResponse | None:
    try:
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
        return result
    except Exception:
        logger.exception("Failed to sync global capabilities after plugin change")
        return None
