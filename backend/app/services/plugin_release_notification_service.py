# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Notify Wework clients when an installed plugin has a newer release."""

from __future__ import annotations

import logging
import os
import threading
from typing import Any

import socketio
from sqlalchemy.orm import Session

from app.api.ws.events import ServerEvents
from app.core.config import settings
from app.core.constants import get_wework_user_room
from app.models.kind import Kind
from app.models.plugin_marketplace import Plugin, PluginRelease

logger = logging.getLogger(__name__)
_manager_lock = threading.Lock()
_manager_pid: int | None = None
_manager: socketio.RedisManager | None = None


def _publish_manager() -> socketio.RedisManager:
    """Return one write-only Socket.IO Redis manager per process."""
    global _manager, _manager_pid
    process_id = os.getpid()
    if _manager is not None and _manager_pid == process_id:
        return _manager
    with _manager_lock:
        if _manager is None or _manager_pid != process_id:
            _manager = socketio.RedisManager(settings.REDIS_URL, write_only=True)
            _manager_pid = process_id
    return _manager


def plugin_auto_update_user_ids(
    db: Session, *, plugin_id: int, release_id: int
) -> list[int]:
    """Return users whose active auto-update install trails this release."""
    rows = (
        db.query(Kind)
        .filter(
            Kind.kind == "InstalledPlugin",
            Kind.namespace == "default",
            Kind.is_active.is_(True),
        )
        .all()
    )
    user_ids: set[int] = set()
    for row in rows:
        spec = (row.json or {}).get("spec")
        source = spec.get("source") if isinstance(spec, dict) else None
        if (
            isinstance(source, dict)
            and source.get("type") == "marketplace"
            and spec.get("pluginId") == plugin_id
            and spec.get("releaseId") != release_id
            and spec.get("updatePolicy") == "auto"
        ):
            user_ids.add(row.user_id)
    return sorted(user_ids)


def emit_plugin_release_available(
    *,
    user_ids: list[int],
    plugin_id: int,
    release_id: int,
    version: str,
    socket_server: Any | None = None,
) -> None:
    """Emit one small invalidation event to each affected Wework user room."""
    sio = socket_server or _publish_manager()
    payload = {
        "pluginId": plugin_id,
        "releaseId": release_id,
        "version": version,
    }
    for user_id in user_ids:
        sio.emit(
            ServerEvents.PLUGIN_RELEASE_AVAILABLE,
            payload,
            room=get_wework_user_room(user_id),
            namespace="/chat",
        )


def notify_plugin_release_available(
    db: Session,
    release_id: int,
    *,
    socket_server: Any | None = None,
) -> int:
    """Broadcast after commit; notification failure never rolls back publication."""
    release = db.get(PluginRelease, release_id)
    plugin = db.get(Plugin, release.plugin_id) if release else None
    if (
        not release
        or not plugin
        or release.status != "ready"
        or release.scan_status != "passed"
        or plugin.latest_release_id != release.id
    ):
        return 0
    user_ids = plugin_auto_update_user_ids(
        db,
        plugin_id=plugin.id,
        release_id=release.id,
    )
    if not user_ids:
        return 0
    try:
        emit_plugin_release_available(
            user_ids=user_ids,
            plugin_id=plugin.id,
            release_id=release.id,
            version=release.version,
            socket_server=socket_server,
        )
    except Exception:
        logger.exception(
            "Failed to dispatch plugin release notification: plugin_id=%s release_id=%s",
            plugin.id,
            release.id,
        )
        return 0
    logger.info(
        "Plugin release notification dispatched: plugin_id=%s release_id=%s users=%s",
        plugin.id,
        release.id,
        len(user_ids),
    )
    return len(user_ids)
