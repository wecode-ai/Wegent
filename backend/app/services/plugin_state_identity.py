"""Keep catalog identity repair on the same durable creation fence."""

from copy import deepcopy

from sqlalchemy import func
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import set_committed_value

from app.models.kind import Kind
from app.models.plugin_state import PluginState
from app.services.plugin_state_store import ensure_plugin_state, find_plugin_state
from app.services.plugin_sync_revision import remember_sync_write
from app.services.plugin_write_errors import PluginWriteError
from shared.telemetry.decorators import trace_sync


def _counter(value: int) -> int:
    if type(value) is not int or not 0 <= value < 2**63 - 1:
        raise PluginWriteError("plugin_write_conflict")
    return value


def _revision(row: PluginState) -> int:
    return _counter(row.json.get("spec", {}).get("revision", 0))


def _identity(row: PluginState):
    return (
        PluginState.id == row.id,
        PluginState.user_id == row.user_id,
        PluginState.plugin_key == row.plugin_key,
        PluginState.installed_kind_id == row.installed_kind_id,
        func.coalesce(PluginState.json["spec"]["revision"].as_integer(), 0)
        == _revision(row),
    )


@trace_sync("plugins.state.rename", "backend.plugins")
def move_plugin_state(db: Session, installed: Kind, new_name: str) -> None:
    """Fence a paused first creator before changing an installation's name."""
    from app.services.plugin_write_coordination import acquire_plugin_write_lock

    acquire_plugin_write_lock(db, installed.user_id, name=new_name)
    db.flush()
    state = ensure_plugin_state(
        db, installed.user_id, installed.name, installed_kind_id=installed.id
    )
    if state.plugin_key == new_name:
        return
    target = find_plugin_state(db, installed.user_id, new_name)
    document = deepcopy(state.json)
    if target is not None:
        _retire_target(db, installed, target)
        target_spec = target.json.get("spec", {})
        spec = document.setdefault("spec", {})
        spec["generation"] = max(
            _counter(spec.get("generation", 0)),
            _counter(target_spec.get("generation", 0)),
        )
        slots = spec.setdefault("creationRevisions", {})
        for key, value in target_spec.get("creationRevisions", {}).items():
            slots[key] = max(_counter(slots.get(key, 0)), _counter(value))
    document.setdefault("metadata", {})["name"] = new_name
    document.setdefault("spec", {})["revision"] = _revision(state) + 1
    changed = (
        db.query(PluginState)
        .filter(*_identity(state))
        .update(
            {PluginState.plugin_key: new_name, PluginState.json: document},
            synchronize_session=False,
        )
    )
    if changed != 1:
        raise PluginWriteError("plugin_write_conflict")
    set_committed_value(state, "plugin_key", new_name)
    set_committed_value(state, "json", document)
    db.info.setdefault("plugin_sync_expected_revisions", {})[state.id] = document[
        "spec"
    ]["revision"]
    db.info.setdefault("plugin_sync_original_documents", {})[state.id] = deepcopy(
        document
    )
    remember_sync_write(db, installed.user_id, new_name)


def _retire_target(db: Session, installed: Kind, target: PluginState) -> None:
    if target.installed_kind_id == installed.id:
        raise PluginWriteError("plugin_write_conflict")
    previous = (
        db.query(Kind)
        .filter_by(
            id=target.installed_kind_id,
            user_id=installed.user_id,
            kind="InstalledPlugin",
            namespace="default",
        )
        .one_or_none()
        if target.installed_kind_id
        else None
    )
    if previous is not None and previous.is_active:
        raise PluginWriteError("plugin_write_conflict")
    if target.installed_kind_id == 0:
        spec = target.json.get("spec", {})
        if any(
            spec.get(field)
            for field in ("devices", "localIntents", "localIntentOrders")
        ):
            raise PluginWriteError("plugin_write_conflict")
        changed = (
            db.query(PluginState)
            .filter(*_identity(target))
            .delete(synchronize_session=False)
        )
    else:
        document = deepcopy(target.json)
        document.setdefault("spec", {})["revision"] = _revision(target) + 1
        retired = f"@retired:{target.id}"
        changed = (
            db.query(PluginState)
            .filter(*_identity(target))
            .update(
                {PluginState.plugin_key: retired, PluginState.json: document},
                synchronize_session=False,
            )
        )
        remember_sync_write(db, target.user_id, retired)
    if changed != 1:
        raise PluginWriteError("plugin_write_conflict")
    db.expunge(target)
