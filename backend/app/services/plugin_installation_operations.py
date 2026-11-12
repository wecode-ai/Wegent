"""Account mutations and device preparation executed in plugin workers."""

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.plugin_marketplace import Plugin
from app.schemas.installed_plugin import InstalledPlugin, InstalledPluginUpdateRequest
from app.services.builtin_plugin_registry import BUILTIN_PLUGIN_OWNER_ID
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


def _builtin_catalog_plugin(db: Session, plugin_key: str) -> Plugin | None:
    """Resolve the catalog identity shared by builtin install and recovery."""
    return (
        db.query(Plugin)
        .filter(
            Plugin.catalog_namespace.in_(
                [ENTERPRISE_CATALOG_NAMESPACE, OFFICIAL_CATALOG_NAMESPACE]
            ),
            Plugin.slug == plugin_key,
        )
        .first()
    )


def find_builtin_account_installation(
    db: Session, *, user_id: int, plugin_key: str
) -> Kind | None:
    """Read the same source as installation, independent of publication status."""
    item = _builtin_catalog_plugin(db, plugin_key)
    if item is not None:
        installed = plugin_marketplace_service._find_installed(
            db, user_id=user_id, plugin_id=item.id
        )
        # The compatibility lookup can also match a legacy catalogItemId.
        # Only an explicit modern plugin identity can prove this watermark.
        if (
            installed is not None
            and installed.json.get("spec", {}).get("pluginId") == item.id
        ):
            return installed
        if installed is not None:
            raise HTTPException(409, "plugin_write_conflict")
        return None
    legacy = installed_plugin_service._find_marketplace_item(
        db, user_id=BUILTIN_PLUGIN_OWNER_ID, plugin_key=plugin_key
    )
    if legacy is None:
        return None
    installed = installed_plugin_service._find_installed_plugin(
        db,
        user_id=user_id,
        source_type="marketplace",
        plugin_key=plugin_key,
        marketplace_id=legacy.id,
    )
    # Legacy Kind catalog IDs and modern Plugin IDs occupy different spaces.
    # A coincident ID/name from another provider cannot prove supersession.
    if (
        installed is not None
        and installed.json.get("spec", {}).get("source", {}).get("providerKey")
        == "wegent-marketplace"
    ):
        return installed
    if installed is not None:
        raise HTTPException(409, "plugin_write_conflict")
    return None


def install_builtin_account_plugin(
    db: Session, *, user_id: int, plugin_key: str, commit: bool = True
) -> InstalledPlugin:
    item = _builtin_catalog_plugin(db, plugin_key)
    if item is not None:
        return plugin_marketplace_service.install(
            db, user_id=user_id, plugin_id=item.id, commit=commit
        )
    return installed_plugin_service.install_builtin_plugin(
        db=db, user_id=user_id, plugin_key=plugin_key, commit=commit
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
