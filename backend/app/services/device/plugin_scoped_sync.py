"""Publish explicit plugin intents without an account-wide synchronization row."""

from collections.abc import Callable
from contextlib import AbstractContextManager
from copy import deepcopy
from typing import Any

from sqlalchemy import exists
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.plugin_state import PluginState
from app.services.plugin_kind_revision import kind_revision
from app.services.plugin_sync_revision import remember_sync_revision
from app.services.plugin_write_coordination import configure_plugin_session
from app.services.plugin_write_errors import PluginWriteError
from app.services.plugin_write_operations import run_plugin_transaction
from shared.telemetry.decorators import trace_sync


def _next_generation(state: PluginState) -> int:
    value = state.json.get("spec", {}).get("generation", 0)
    if type(value) is not int or not 0 <= value < 2**63 - 2:
        raise PluginWriteError("plugin_write_conflict")
    return value + 1


def _snapshot_fences(
    db: Session, user_id: int
) -> list[tuple[Kind | None, PluginState]]:
    from app.services.device.plugin_sync_protocol import lock_plugin_sync_state

    installed = (
        db.query(Kind)
        .filter_by(user_id=user_id, kind="InstalledPlugin", namespace="default")
        .order_by(Kind.name, Kind.id)
        .all()
    )
    fences = [
        (
            row,
            lock_plugin_sync_state(
                db, user_id, plugin_key=row.name, installed_kind_id=row.id
            ),
        )
        for row in installed
    ]
    # Identity discovery may precede a concurrent commit. Read the intent only
    # after capturing all metadata revisions, so its CAS fences this read.
    with db.no_autoflush:
        fresh = {
            row.id: row
            for row in db.query(Kind)
            .filter(
                Kind.user_id == user_id,
                Kind.kind == "InstalledPlugin",
                Kind.namespace == "default",
                Kind.id.in_([row.id for row in installed]),
            )
            .populate_existing()
            .all()
        }
    if set(fresh) != {row.id for row in installed}:
        raise PluginWriteError("plugin_write_conflict")
    result = [(fresh[row.id], state) for row, state in fences]
    orphans = (
        db.query(PluginState)
        .filter(
            PluginState.user_id == user_id,
            PluginState.installed_kind_id > 0,
            ~exists().where(
                Kind.id == PluginState.installed_kind_id,
                Kind.user_id == user_id,
                Kind.kind == "InstalledPlugin",
                Kind.namespace == "default",
            ),
        )
        .order_by(PluginState.plugin_key)
        .all()
    )
    for state in orphans:
        identity = state.json.get("spec", {}).get("runtimeIdentity")
        if (
            isinstance(identity, dict)
            and identity.get("installed_plugin_id") == state.installed_kind_id
        ):
            remember_sync_revision(db, state)
            result.append((None, state))
    return result


def _append_tombstones(
    payload: dict, fences: list[tuple[Kind | None, PluginState]]
) -> None:
    from app.services.device.capability_sync_service import (
        device_capability_sync_service,
    )

    removed = list(payload.get("removed_plugins") or [])
    included = {item["installed_plugin_id"] for item in removed}
    included.update(
        item["installed_plugin_id"] for item in payload.get("plugins") or []
    )
    for row, state in fences:
        if state.installed_kind_id in included:
            continue
        if row is None:
            removed.append(deepcopy(state.json["spec"]["runtimeIdentity"]))
            included.add(state.installed_kind_id)
            continue
        spec = row.json.get("spec", {})
        source = spec.get("source") or {}
        removed.append(
            {
                "installed_plugin_id": row.id,
                "name": device_capability_sync_service._plugin_payload_name(
                    row, spec, source
                ),
                "marketplace": spec.get("marketplace") or source.get("marketplace"),
            }
        )
        included.add(row.id)
    if removed:
        payload["removed_plugins"] = removed


@trace_sync("device.plugin_sync.scoped_snapshot", "backend.device")
def load_plugin_scoped_payload(
    session_factory: Callable[[], AbstractContextManager[Session]],
    *,
    user_id: int,
    load_payload: Callable[[Session], dict[str, Any]],
    complete: bool,
    all_capabilities: bool = False,
) -> dict[str, Any]:
    """CAS each included plugin after reading desired state; absence never deletes."""
    from app.services.device.plugin_sync_protocol import lock_plugin_sync_state

    def build(db: Session) -> dict[str, Any]:
        configure_plugin_session(db)
        fences = _snapshot_fences(db, user_id)
        # A full capability request also orders skills/MCPs, which share their
        # own stream. Plugin-only requests never read or write that stream.
        capabilities = (
            None
            if not all_capabilities
            else lock_plugin_sync_state(db, user_id, plugin_key="@capabilities")
        )
        payload = dict(load_payload(db))
        if (
            payload.get("scope") not in {"plugins", "plugin_delta"}
            and capabilities is None
        ):
            raise PluginWriteError("plugin_write_conflict")
        if complete:
            _append_tombstones(payload, fences)
        included = {
            item["installed_plugin_id"]
            for field in ("plugins", "removed_plugins")
            for item in payload.get(field) or []
        }
        revisions, intents = {}, {}
        for installed, state in fences:
            installed_id = state.installed_kind_id
            if installed_id not in included:
                continue
            generation = _next_generation(state)
            document = deepcopy(state.json)
            document.setdefault("spec", {})["generation"] = generation
            item = next(
                item
                for field in ("plugins", "removed_plugins")
                for item in payload.get(field) or []
                if item["installed_plugin_id"] == installed_id
            )
            document["spec"]["runtimeIdentity"] = runtime_identity(item)
            state.json = document
            key = str(installed_id)
            revisions[key] = generation
            intents[key] = kind_revision(installed) if installed is not None else 0
        if included != {int(key) for key in revisions}:
            raise PluginWriteError("plugin_write_conflict")
        generation = max(revisions.values(), default=1)
        if capabilities is not None:
            generation = _next_generation(capabilities)
            document = deepcopy(capabilities.json)
            document.setdefault("spec", {})["generation"] = generation
            capabilities.json = document
        payload["plugin_sync"] = {
            "version": 3,
            "generation": generation,
            "complete": False,
            "revisions": revisions,
            "intentRevisions": intents,
        }
        db.commit()
        return payload

    return run_plugin_transaction(build, session_factory, attempts=8)


def runtime_identity(item: dict) -> dict:
    return {
        key: item.get(key) for key in ("installed_plugin_id", "name", "marketplace")
    }


def remember_runtime_identities(db: Session, user_id: int, payload: dict) -> None:
    from app.services.device.plugin_sync_protocol import lock_installed_plugin_state

    for field in ("plugins", "removed_plugins"):
        for item in payload.get(field) or []:
            state = lock_installed_plugin_state(
                db, user_id, item["installed_plugin_id"], merge=True
            )
            identity = runtime_identity(item)
            if state.json.get("spec", {}).get("runtimeIdentity") != identity:
                document = deepcopy(state.json)
                document.setdefault("spec", {})["runtimeIdentity"] = identity
                state.json = document


def register_scoped_snapshot_intent(
    session_factory: Callable[[], AbstractContextManager[Session]],
    *,
    user_id: int,
    device_id: str,
    payload: dict[str, Any],
) -> None:
    from app.services.device.plugin_sync_protocol import (
        advance_plugin_snapshot_watermark,
        lock_installed_plugin_state,
    )
    from app.services.plugin_device_identity import plugin_device_id

    def register(db: Session) -> None:
        configure_plugin_session(db)
        canonical_device = plugin_device_id(db, user_id, device_id)
        for item in sorted(
            [
                item
                for field in ("plugins", "removed_plugins")
                for item in payload.get(field) or []
            ],
            key=lambda item: item["installed_plugin_id"],
        ):
            installed_id = item["installed_plugin_id"]
            state = (
                db.query(PluginState)
                .filter_by(user_id=user_id, installed_kind_id=installed_id)
                .one_or_none()
            )
            if state is None:
                raise PluginWriteError("plugin_write_conflict")
            remember_sync_revision(db, state, merge=True)
            generation = payload["plugin_sync"]["revisions"][str(installed_id)]
            advance_plugin_snapshot_watermark(
                state,
                canonical_device,
                generation=generation,
                complete=False,
                installed_plugin_ids=[installed_id],
            )
        db.commit()

    run_plugin_transaction(register, session_factory, attempts=8)
