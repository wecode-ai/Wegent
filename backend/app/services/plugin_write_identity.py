"""Stable, device-independent lock identities for existing installation paths."""

from collections.abc import Callable

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.plugin_marketplace import Plugin
from app.services.plugin_marketplace_identity import installed_plugin_kind_name
from app.services.plugin_write_errors import PluginWriteError


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


def acquire_installation_write_lock(
    db: Session,
    user_id: int,
    *,
    creation_name: str,
    find_existing: Callable[[], Kind | None],
) -> Kind | None:
    """Resolve an existing identity before creating any first-install fence."""
    from app.services.plugin_write_coordination import (
        acquire_plugin_write_lock,
        configure_plugin_session,
    )

    configure_plugin_session(db)
    existing = find_existing()
    name = existing.name if existing is not None else creation_name
    acquire_plugin_write_lock(db, user_id, name=name)
    # A creator or catalog rename may have committed while the lease was busy.
    existing = find_existing()
    current_name = (
        installed_write_name(db, user_id, existing.id)
        if existing is not None
        else creation_name
    )
    if current_name != name:
        raise PluginWriteError("plugin_write_conflict")
    if existing is not None:
        acquire_plugin_write_lock(db, user_id, installed_id=existing.id)
        db.refresh(existing)
    return existing


def marketplace_write_name(db: Session, user_id: int, plugin_id: int) -> str:
    from app.services.plugin_marketplace_service import plugin_marketplace_service

    plugin = db.get(Plugin, plugin_id)
    if plugin is None:
        raise HTTPException(404, "Marketplace plugin not found")
    existing = plugin_marketplace_service._find_installation_for_plugin(
        db, user_id=user_id, plugin=plugin
    )
    if existing is not None:
        return installed_write_name(db, user_id, existing.id)
    return installed_plugin_kind_name(plugin.catalog_namespace, plugin.slug)


def local_write_name(
    db: Session, user_id: int, action: str, target_id: int | str
) -> str:
    if action == "install":
        return marketplace_write_name(db, user_id, int(target_id))
    if action == "ensure_builtin":
        from app.services.builtin_plugin_registry import BUILTIN_PLUGIN_OWNER_ID
        from app.services.installed_plugin_service import installed_plugin_service
        from app.services.plugin_installation_operations import (
            _builtin_catalog_plugin,
            find_builtin_account_installation,
        )

        plugin = _builtin_catalog_plugin(db, str(target_id))
        if plugin is not None:
            return marketplace_write_name(db, user_id, plugin.id)
        installed = find_builtin_account_installation(
            db, user_id=user_id, plugin_key=str(target_id)
        )
        if installed is not None:
            return installed_write_name(db, user_id, installed.id)
        row = installed_plugin_service._find_marketplace_item(
            db, user_id=BUILTIN_PLUGIN_OWNER_ID, plugin_key=str(target_id)
        )
        if row is None:
            raise HTTPException(503, f"Built-in plugin is unavailable: {target_id}")
        return installed_plugin_service._safe_kind_name(
            installed_plugin_service._get_spec(row).get("name", str(target_id))
        )
    return installed_write_name(db, user_id, int(target_id))
