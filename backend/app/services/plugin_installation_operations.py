"""Account mutations and device preparation executed in plugin workers."""

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.plugin_marketplace import Plugin
from app.schemas.installed_plugin import InstalledPlugin, InstalledPluginUpdateRequest
from app.services.device.plugin_removal_sync import prepare_plugin_removal
from app.services.installed_plugin_service import installed_plugin_service
from app.services.plugin_device_installation_service import (
    plugin_device_installation_service,
)
from app.services.plugin_marketplace_identity import (
    ENTERPRISE_CATALOG_NAMESPACE,
    OFFICIAL_CATALOG_NAMESPACE,
)
from app.services.plugin_marketplace_service import plugin_marketplace_service


def install_builtin_account_plugin(
    db: Session, *, user_id: int, plugin_key: str
) -> InstalledPlugin:
    item = (
        db.query(Plugin)
        .filter(
            Plugin.catalog_namespace.in_(
                [ENTERPRISE_CATALOG_NAMESPACE, OFFICIAL_CATALOG_NAMESPACE]
            ),
            Plugin.slug == plugin_key,
        )
        .first()
    )
    if item is not None:
        return plugin_marketplace_service.install(
            db, user_id=user_id, plugin_id=item.id
        )
    return installed_plugin_service.install_builtin_plugin(
        db=db, user_id=user_id, plugin_key=plugin_key
    )


def update_account_plugin(
    db: Session,
    *,
    user_id: int,
    installed_id: int,
    request: InstalledPluginUpdateRequest,
) -> InstalledPlugin:
    if request.releaseId is not None:
        return plugin_marketplace_service.update_release(
            db,
            user_id=user_id,
            installed_id=installed_id,
            release_id=request.releaseId,
        )
    return installed_plugin_service.update_installed_plugin(
        db=db, user_id=user_id, installed_id=installed_id, request=request
    )


def uninstall_account_plugin(db: Session, *, user_id: int, installed_id: int) -> None:
    prepare_plugin_removal(db, user_id, installed_id)
    try:
        installed_plugin_service.uninstall_installed_plugin(
            db=db, user_id=user_id, installed_id=installed_id
        )
    except HTTPException as exc:
        if exc.status_code != status.HTTP_404_NOT_FOUND:
            raise
        # A previous account uninstall may already have committed.
        db.commit()


def prepare_device_plugin_sync(
    db: Session,
    *,
    user_id: int,
    device_id: str,
    installed_id: int | None = None,
) -> int:
    if installed_id is not None:
        return plugin_device_installation_service.ensure_plugin_pending_for_device(
            db,
            user_id=user_id,
            device_id=device_id,
            installed_kind_id=installed_id,
        )
    plugin_marketplace_service.reconcile_stale_installed_catalog_refs(
        db, user_id=user_id
    )
    return plugin_device_installation_service.ensure_pending_for_device(
        db, user_id=user_id, device_id=device_id
    )
