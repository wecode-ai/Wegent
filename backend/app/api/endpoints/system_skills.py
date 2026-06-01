# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import logging
from typing import Literal, Optional

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.models.user import User
from app.schemas.system_skills import (
    InstalledSkill,
    InstalledSkillListResponse,
    SystemSkillInstallRequest,
    SystemSkillListResponse,
    SystemSkillProviderListResponse,
    SystemSkillUpdateInstalledRequest,
)
from app.services.device.capability_sync_service import device_capability_sync_service
from app.services.system_skill_providers.service import system_skill_provider_service

router = APIRouter(tags=["system-skills"])
logger = logging.getLogger(__name__)


@router.get("/providers", response_model=SystemSkillProviderListResponse)
def list_system_skill_providers(
    current_user: User = Depends(security.get_current_user),
) -> SystemSkillProviderListResponse:
    """List available system skill providers."""
    _ = current_user
    return system_skill_provider_service.list_providers()


@router.get("", response_model=SystemSkillListResponse)
async def list_system_skills(
    providerKey: Optional[str] = Query(None),
    keyword: Optional[str] = Query(None),
    tags: Optional[str] = Query(None),
    page: int = Query(1, ge=1),
    pageSize: int = Query(20, ge=1, le=100),
    category: Literal["system"] = Query("system"),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> SystemSkillListResponse:
    """List or search system skills."""
    parsed_tags = _parse_tags(tags)

    return await system_skill_provider_service.list_system_skills(
        db=db,
        user_id=current_user.id,
        user_name=current_user.user_name,
        provider_key=providerKey,
        keyword=keyword,
        tags=parsed_tags,
        page=page,
        page_size=pageSize,
    )


@router.post(
    "/install",
    response_model=InstalledSkill,
    status_code=status.HTTP_201_CREATED,
)
async def install_system_skill(
    request: SystemSkillInstallRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> InstalledSkill:
    """Install a system skill for the current user."""
    logger.info(
        "System skill install requested: user_id=%s provider=%s skill=%s catalog_item=%s",
        current_user.id,
        request.providerKey,
        request.skillKey,
        request.catalogItemId,
    )
    installed = await system_skill_provider_service.install_system_skill(
        db=db,
        user_id=current_user.id,
        request=request,
    )
    logger.info(
        "System skill install completed: user_id=%s installed_id=%s skill=%s enabled=%s state=%s",
        current_user.id,
        _installed_skill_id(installed),
        installed.spec.source.skillKey,
        installed.spec.enabled,
        installed.spec.installState,
    )
    await _sync_global_capabilities(db, current_user.id)
    return installed


@router.get("/installed", response_model=InstalledSkillListResponse)
def list_installed_system_skills(
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> InstalledSkillListResponse:
    """List system skills installed by the current user."""
    return system_skill_provider_service.list_installed_system_skills(
        db=db,
        user_id=current_user.id,
    )


@router.put("/installed/{installed_id}", response_model=InstalledSkill)
async def update_installed_system_skill(
    installed_id: int,
    request: SystemSkillUpdateInstalledRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> InstalledSkill:
    """Enable or disable an installed system skill."""
    logger.info(
        "System skill update requested: user_id=%s installed_id=%s enabled=%s",
        current_user.id,
        installed_id,
        request.enabled,
    )
    installed = system_skill_provider_service.update_installed_system_skill(
        db=db,
        user_id=current_user.id,
        installed_id=installed_id,
        request=request,
    )
    logger.info(
        "System skill update completed: user_id=%s installed_id=%s skill=%s enabled=%s state=%s",
        current_user.id,
        _installed_skill_id(installed),
        installed.spec.source.skillKey,
        installed.spec.enabled,
        installed.spec.installState,
    )
    await _sync_global_capabilities(db, current_user.id)
    return installed


@router.delete("/installed/{installed_id}", status_code=status.HTTP_204_NO_CONTENT)
async def uninstall_installed_system_skill(
    installed_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> None:
    """Uninstall a system skill for the current user."""
    logger.info(
        "System skill uninstall requested: user_id=%s installed_id=%s",
        current_user.id,
        installed_id,
    )
    system_skill_provider_service.uninstall_installed_system_skill(
        db=db,
        user_id=current_user.id,
        installed_id=installed_id,
    )
    logger.info(
        "System skill uninstall completed: user_id=%s installed_id=%s",
        current_user.id,
        installed_id,
    )
    await _sync_global_capabilities(db, current_user.id)


def _parse_tags(tags: Optional[str]) -> Optional[list[str]]:
    if not tags:
        return None

    parsed_tags = [tag.strip() for tag in tags.split(",") if tag.strip()]
    return parsed_tags or None


async def _sync_global_capabilities(db: Session, user_id: int) -> None:
    try:
        result = await device_capability_sync_service.sync_user_global_capabilities(
            db,
            user_id=user_id,
        )
        logger.info(
            "Global capability sync after skill change completed: user_id=%s synced=%s failed=%s skipped=%s",
            user_id,
            result.synced,
            result.failed,
            result.skipped,
        )
    except Exception:
        logger.exception("Failed to sync global capabilities after skill change")


def _installed_skill_id(installed: InstalledSkill) -> str:
    labels = installed.metadata.get("labels") if installed.metadata else None
    if isinstance(labels, dict):
        return str(labels.get("id"))
    return "unknown"
