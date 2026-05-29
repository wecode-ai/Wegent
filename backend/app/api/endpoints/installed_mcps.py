# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import logging

from fastapi import APIRouter, Depends, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.models.user import User
from app.schemas.installed_mcp import (
    InstalledMCP,
    InstalledMCPCustomCreateRequest,
    InstalledMCPInstallRequest,
    InstalledMCPListResponse,
    InstalledMCPUpdateRequest,
)
from app.services.device.capability_sync_service import device_capability_sync_service
from app.services.installed_mcp_service import installed_mcp_service

router = APIRouter(tags=["mcps"])
logger = logging.getLogger(__name__)


@router.get("/installed", response_model=InstalledMCPListResponse)
def list_installed_mcps(
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> InstalledMCPListResponse:
    """List MCP servers installed by the current user."""
    return installed_mcp_service.list_installed_mcps(
        db=db,
        user_id=current_user.id,
    )


@router.post(
    "/custom",
    response_model=InstalledMCP,
    status_code=status.HTTP_201_CREATED,
)
async def create_custom_mcp(
    request: InstalledMCPCustomCreateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> InstalledMCP:
    """Create or reactivate a custom MCP installation."""
    logger.info(
        "Custom MCP create requested: user_id=%s name=%s enabled=%s",
        current_user.id,
        request.name,
        request.enabled,
    )
    installed = installed_mcp_service.create_custom_mcp(
        db=db,
        user_id=current_user.id,
        request=request,
    )
    logger.info(
        "Custom MCP create completed: user_id=%s installed_id=%s name=%s enabled=%s state=%s",
        current_user.id,
        _installed_mcp_id(installed),
        installed.metadata.get("name"),
        installed.spec.enabled,
        installed.spec.installState,
    )
    await _sync_global_capabilities(db, current_user.id)
    return installed


@router.post(
    "/install",
    response_model=InstalledMCP,
    status_code=status.HTTP_201_CREATED,
)
async def install_provider_mcp(
    request: InstalledMCPInstallRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> InstalledMCP:
    """Install or reactivate an MCP server from a provider catalog."""
    logger.info(
        "Provider MCP install requested: user_id=%s provider=%s server=%s catalog_item=%s",
        current_user.id,
        request.providerKey,
        request.serverKey,
        request.catalogItemId,
    )
    installed = installed_mcp_service.install_provider_mcp(
        db=db,
        user_id=current_user.id,
        request=request,
    )
    logger.info(
        "Provider MCP install completed: user_id=%s installed_id=%s name=%s enabled=%s state=%s",
        current_user.id,
        _installed_mcp_id(installed),
        installed.metadata.get("name"),
        installed.spec.enabled,
        installed.spec.installState,
    )
    await _sync_global_capabilities(db, current_user.id)
    return installed


@router.put("/installed/{installed_id}", response_model=InstalledMCP)
async def update_installed_mcp(
    installed_id: int,
    request: InstalledMCPUpdateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> InstalledMCP:
    """Update an installed MCP configuration or enabled state."""
    logger.info(
        "MCP update requested: user_id=%s installed_id=%s enabled=%s",
        current_user.id,
        installed_id,
        request.enabled,
    )
    installed = installed_mcp_service.update_installed_mcp(
        db=db,
        user_id=current_user.id,
        installed_id=installed_id,
        request=request,
    )
    logger.info(
        "MCP update completed: user_id=%s installed_id=%s name=%s enabled=%s state=%s",
        current_user.id,
        _installed_mcp_id(installed),
        installed.metadata.get("name"),
        installed.spec.enabled,
        installed.spec.installState,
    )
    await _sync_global_capabilities(db, current_user.id)
    return installed


@router.delete("/installed/{installed_id}", status_code=status.HTTP_204_NO_CONTENT)
async def uninstall_installed_mcp(
    installed_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> None:
    """Uninstall a user-scoped MCP server."""
    logger.info(
        "MCP uninstall requested: user_id=%s installed_id=%s",
        current_user.id,
        installed_id,
    )
    installed_mcp_service.uninstall_installed_mcp(
        db=db,
        user_id=current_user.id,
        installed_id=installed_id,
    )
    logger.info(
        "MCP uninstall completed: user_id=%s installed_id=%s",
        current_user.id,
        installed_id,
    )
    await _sync_global_capabilities(db, current_user.id)


async def _sync_global_capabilities(db: Session, user_id: int) -> None:
    try:
        result = await device_capability_sync_service.sync_user_global_capabilities(
            db,
            user_id=user_id,
        )
        logger.info(
            "Global capability sync after MCP change completed: user_id=%s synced=%s failed=%s skipped=%s",
            user_id,
            result.synced,
            result.failed,
            result.skipped,
        )
    except Exception:
        logger.exception("Failed to sync global capabilities after MCP change")


def _installed_mcp_id(installed: InstalledMCP) -> str:
    labels = installed.metadata.get("labels") if installed.metadata else None
    if isinstance(labels, dict):
        return str(labels.get("id"))
    return "unknown"
