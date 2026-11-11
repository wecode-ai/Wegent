"""Stable, device-independent lock identities for existing installation paths."""

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.plugin_marketplace import Plugin
from app.services.plugin_marketplace_identity import installed_plugin_kind_name


def installed_write_name(db: Session, user_id: int, installed_id: int) -> str:
    row = (
        db.query(Kind.name)
        .filter_by(
            id=installed_id,
            user_id=user_id,
            kind="InstalledPlugin",
            namespace="default",
        )
        .one_or_none()
    )
    if row is None:
        raise HTTPException(404, "Installed plugin not found")
    return row.name


def marketplace_write_name(db: Session, plugin_id: int) -> str:
    plugin = db.get(Plugin, plugin_id)
    if plugin is None:
        raise HTTPException(404, "Marketplace plugin not found")
    return installed_plugin_kind_name(plugin.catalog_namespace, plugin.slug)


def local_write_name(
    db: Session, user_id: int, action: str, target_id: int | str
) -> str:
    if action == "install":
        return marketplace_write_name(db, int(target_id))
    if action == "ensure_builtin":
        from app.services.builtin_plugin_registry import BUILTIN_PLUGIN_OWNER_ID
        from app.services.installed_plugin_service import installed_plugin_service
        from app.services.plugin_installation_operations import _builtin_catalog_plugin

        plugin = _builtin_catalog_plugin(db, str(target_id))
        if plugin is not None:
            return installed_plugin_kind_name(plugin.catalog_namespace, plugin.slug)
        row = installed_plugin_service._find_marketplace_item(
            db, user_id=BUILTIN_PLUGIN_OWNER_ID, plugin_key=str(target_id)
        )
        if row is None:
            raise HTTPException(503, f"Built-in plugin is unavailable: {target_id}")
        return installed_plugin_service._safe_kind_name(
            installed_plugin_service._get_spec(row).get("name", str(target_id))
        )
    return installed_write_name(db, user_id, int(target_id))
