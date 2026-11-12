# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Negotiate and order fresh plugin snapshots without holding locks across RPC."""

from __future__ import annotations

from collections.abc import Callable, Iterable
from contextlib import AbstractContextManager
from copy import deepcopy
from typing import Any

from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.plugin_state import PluginState
from app.services.plugin_state_store import LEGACY_SYNC_KEY, ensure_plugin_state
from app.services.plugin_sync_revision import (
    remember_sync_revision,
)
from app.services.plugin_write_coordination import configure_plugin_session
from shared.telemetry.decorators import trace_sync

PLUGIN_SYNC_VERSION = 2
PLUGIN_SYNC_STATE_KIND = "PluginSyncState"
PLUGIN_SYNC_STATE_NAMESPACE = "plugin-sync"
PLUGIN_SYNC_STATE_NAME = "account"


def supports_plugin_sync_v2(runtime_features: Any) -> bool:
    return plugin_sync_version(runtime_features) is not None


def plugin_sync_version(runtime_features: Any) -> int | None:
    """Require an explicit supported protocol, never infer it from app versions."""
    if not isinstance(runtime_features, dict):
        return None
    advertisement = runtime_features.get("pluginSync")
    if not isinstance(advertisement, dict):
        return None
    supported = advertisement.get("supportedVersions", [])
    if isinstance(supported, list) and any(
        type(v) is int and v == 3 for v in supported
    ):
        return 3
    version = advertisement.get("protocolVersion")
    return version if type(version) is int and version in {2, 3} else None


def supports_snapshot(runtime_features: Any, payload: dict) -> bool:
    version = (payload.get("plugin_sync") or {}).get("version")
    selected = plugin_sync_version(runtime_features)
    return selected == version or (version == 2 and selected == 3)


@trace_sync("device.plugin_sync.snapshot", "backend.device")
def load_versioned_plugin_payload(
    session_factory: Callable[[], AbstractContextManager[Session]],
    *,
    user_id: int,
    load_payload: Callable[[Session], dict[str, Any]],
    complete: bool,
    protocol_version: int = 2,
    all_capabilities: bool = False,
) -> dict[str, Any]:
    """Commit a snapshot's sequence before dispatch, using a fresh DB session.

    The loader must resolve committed desired state inside this transaction,
    rather than reuse an earlier request's ORM objects or payload. Metadata CAS
    retries ensure a higher generation cannot describe an older committed state.
    """
    if protocol_version == 3:
        from app.services.device.plugin_scoped_sync import load_plugin_scoped_payload

        return load_plugin_scoped_payload(
            session_factory,
            user_id=user_id,
            load_payload=load_payload,
            complete=complete,
            all_capabilities=all_capabilities,
        )
    if protocol_version != 2:
        raise ValueError("Unsupported plugin sync protocol")
    from app.services.plugin_write_operations import run_plugin_transaction

    def build(db: Session) -> tuple[dict[str, Any], int]:
        from app.services.device.plugin_scoped_sync import _snapshot_fences
        from app.services.plugin_sync_revision import require_snapshot_revision

        state = lock_plugin_sync_state(db, user_id)
        generation = _next_generation(state)
        fences = _snapshot_fences(db, user_id)
        for _installed, fence in fences:
            require_snapshot_revision(db, fence)
        payload = dict(load_payload(db))
        from app.services.device.plugin_scoped_sync import remember_runtime_identities

        remember_runtime_identities(db, user_id, payload)
        for _installed, fence in fences:
            fence.json = deepcopy(fence.json)
        document = deepcopy(state.json)
        document.setdefault("spec", {})["generation"] = generation
        state.json = document
        db.commit()
        return payload, generation

    payload, generation = run_plugin_transaction(build, session_factory, attempts=8)
    payload["plugin_sync"] = {
        "version": PLUGIN_SYNC_VERSION,
        "generation": generation,
        "complete": complete,
    }
    return payload


@trace_sync("device.plugin_sync.intent", "backend.device")
def register_plugin_snapshot_intent(
    session_factory: Callable[[], AbstractContextManager[Session]],
    *,
    user_id: int,
    device_id: str,
    payload: dict[str, Any],
) -> None:
    """Fence older acknowledgements before emitting this snapshot's RPC."""
    from app.services.plugin_device_identity import plugin_device_id

    metadata = payload["plugin_sync"]
    if metadata["version"] == 3:
        from app.services.device.plugin_scoped_sync import (
            register_scoped_snapshot_intent,
        )

        return register_scoped_snapshot_intent(
            session_factory, user_id=user_id, device_id=device_id, payload=payload
        )
    from app.services.plugin_write_operations import run_plugin_transaction

    def register(db: Session) -> None:
        state = lock_plugin_sync_state(db, user_id)
        canonical_device_id = plugin_device_id(db, user_id, device_id)
        advance_plugin_snapshot_watermark(
            state,
            canonical_device_id,
            generation=metadata["generation"],
            complete=metadata["complete"],
            installed_plugin_ids=[
                item["installed_plugin_id"]
                for field in ("plugins", "removed_plugins")
                for item in payload.get(field) or []
            ],
        )
        db.commit()

    run_plugin_transaction(register, session_factory, attempts=8)


def lock_plugin_sync_state(
    db: Session,
    user_id: int,
    *,
    merge: bool = False,
    plugin_key: str = LEGACY_SYNC_KEY,
    installed_kind_id: int = 0,
) -> PluginState:
    """Read one durable plugin identity; the reserved key serves legacy V2 only."""
    configure_plugin_session(db)
    creation = db.info.get("plugin_creation_revisions", {}).get((user_id, plugin_key))
    rebind = creation is not None and any(
        row.id == installed_kind_id
        and row.user_id == user_id
        and row.name == plugin_key
        for row in db.info.get("plugin_new_installations", [])
    )
    state = ensure_plugin_state(
        db,
        user_id,
        plugin_key,
        installed_kind_id=installed_kind_id,
        previous_installed_id=creation.installed_kind_id if rebind else None,
    )
    remember_sync_revision(db, state, merge=merge)
    return state


def lock_installed_plugin_state(
    db: Session, user_id: int, installed_id: int, *, merge: bool = False
) -> PluginState:
    with db.no_autoflush:
        installed = (
            db.query(Kind.name)
            .filter_by(
                id=installed_id,
                user_id=user_id,
                kind="InstalledPlugin",
                namespace="default",
            )
            .one_or_none()
        )
    if installed is None:
        from app.services.plugin_write_errors import PluginWriteError

        raise PluginWriteError("plugin_write_conflict")
    return lock_plugin_sync_state(
        db,
        user_id,
        merge=merge,
        plugin_key=installed.name,
        installed_kind_id=installed_id,
    )


def plugin_snapshot_watermark(
    state: PluginState, device_id: str, installed_id: int
) -> int:
    device = (state.json.get("spec") or {}).get("devices", {}).get(device_id, {})
    return max(
        _generation(device.get("complete_generation", 0)),
        _generation(device.get("plugins", {}).get(str(installed_id), 0)),
    )


def advance_plugin_snapshot_watermark(
    state: PluginState,
    device_id: str,
    *,
    generation: int,
    complete: bool,
    installed_plugin_ids: Iterable[int],
) -> None:
    """Retain per-plugin ordering while independent plugin requests overlap."""
    generation = _generation(generation)
    document = deepcopy(state.json)
    spec = document.setdefault("spec", {})
    spec["generation"] = max(_generation(spec.get("generation", 0)), generation)
    device = spec.setdefault("devices", {}).setdefault(device_id, {})
    if complete:
        device["complete_generation"] = max(
            _generation(device.get("complete_generation", 0)), generation
        )
    plugins = device.setdefault("plugins", {})
    for installed_id in installed_plugin_ids:
        key = str(installed_id)
        plugins[key] = max(_generation(plugins.get(key, 0)), generation)
    state.json = document


def _next_generation(state: PluginState) -> int:
    spec = (state.json or {}).get("spec") or {}
    return _generation(spec.get("generation", 0)) + 1


def _generation(value: Any) -> int:
    if type(value) is not int or value < 0:
        raise ValueError("Invalid plugin sync generation")
    return value
