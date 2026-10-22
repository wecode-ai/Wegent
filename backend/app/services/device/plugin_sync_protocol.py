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
from app.services.plugin_write_coordination import (
    acquire_plugin_write_lock,
    configure_plugin_session,
)
from shared.telemetry.decorators import trace_sync

PLUGIN_SYNC_VERSION = 2
PLUGIN_SYNC_STATE_KIND = "PluginSyncState"
PLUGIN_SYNC_STATE_NAMESPACE = "plugin-sync"
PLUGIN_SYNC_STATE_NAME = "account"


def supports_plugin_sync_v2(runtime_features: Any) -> bool:
    """Require an explicit supported protocol, never infer it from app versions."""
    if not isinstance(runtime_features, dict):
        return False
    advertisement = runtime_features.get("pluginSync")
    if not isinstance(advertisement, dict):
        return False
    version = advertisement.get("protocolVersion")
    return type(version) is int and version == PLUGIN_SYNC_VERSION


@trace_sync("device.plugin_sync.snapshot", "backend.device")
def load_versioned_plugin_payload(
    session_factory: Callable[[], AbstractContextManager[Session]],
    *,
    user_id: int,
    load_payload: Callable[[Session], dict[str, Any]],
    complete: bool,
) -> dict[str, Any]:
    """Commit a snapshot's sequence before dispatch, using a fresh DB session.

    The loader must resolve committed desired state inside this transaction,
    rather than reuse an earlier request's ORM objects or payload. Serializing
    snapshot reads ensures a higher generation cannot describe an older state.
    """
    with session_factory() as db:
        try:
            state = lock_plugin_sync_state(db, user_id)
            generation = _next_generation(state)
            payload = dict(load_payload(db))
            document = deepcopy(state.json)
            document.setdefault("spec", {})["generation"] = generation
            state.json = document
            db.commit()
        except Exception:
            db.rollback()
            raise
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
    with session_factory() as db:
        try:
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
        except Exception:
            db.rollback()
            raise


def lock_plugin_sync_state(db: Session, user_id: int) -> Kind:
    """Serialize protocol writes with the account lease and revision CAS."""
    configure_plugin_session(db)
    acquire_plugin_write_lock(db, user_id)
    pending = [
        row
        for row in set(db.new) | set(db.dirty)
        if isinstance(row, Kind)
        and row.user_id == user_id
        and row.kind == PLUGIN_SYNC_STATE_KIND
        and row.namespace == PLUGIN_SYNC_STATE_NAMESPACE
        and row.name == PLUGIN_SYNC_STATE_NAME
    ]
    if pending:
        # Batch recording re-enters with autoflush disabled. Preserve earlier
        # devices' changes before the locking read refreshes this identity.
        db.flush(pending)
    return _sync_state(db, user_id)


def plugin_snapshot_watermark(state: Kind, device_id: str, installed_id: int) -> int:
    device = (state.json.get("spec") or {}).get("devices", {}).get(device_id, {})
    return max(
        _generation(device.get("complete_generation", 0)),
        _generation(device.get("plugins", {}).get(str(installed_id), 0)),
    )


def advance_plugin_snapshot_watermark(
    state: Kind,
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


def _sync_state(db: Session, user_id: int) -> Kind:
    state = (
        db.query(Kind)
        .filter(
            Kind.user_id == user_id,
            Kind.kind == PLUGIN_SYNC_STATE_KIND,
            Kind.namespace == PLUGIN_SYNC_STATE_NAMESPACE,
            Kind.name == PLUGIN_SYNC_STATE_NAME,
            Kind.is_active.is_(True),
        )
        .populate_existing()
        .one_or_none()
    )
    if state is None:
        state = Kind(
            user_id=user_id,
            kind=PLUGIN_SYNC_STATE_KIND,
            namespace=PLUGIN_SYNC_STATE_NAMESPACE,
            name=PLUGIN_SYNC_STATE_NAME,
            json={
                "apiVersion": "agent.wecode.io/v1",
                "kind": PLUGIN_SYNC_STATE_KIND,
                "metadata": {
                    "name": PLUGIN_SYNC_STATE_NAME,
                    "namespace": PLUGIN_SYNC_STATE_NAMESPACE,
                },
                "spec": {"generation": 0},
            },
            is_active=True,
        )
        db.add(state)
    return state


def _next_generation(state: Kind) -> int:
    spec = (state.json or {}).get("spec") or {}
    return _generation(spec.get("generation", 0)) + 1


def _generation(value: Any) -> int:
    if type(value) is not int or value < 0:
        raise ValueError("Invalid plugin sync generation")
    return value
