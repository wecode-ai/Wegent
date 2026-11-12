"""CAS independent plugin documents and merge device-specific watermarks."""

import json
from copy import deepcopy

from sqlalchemy import BigInteger, cast, func, select
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import set_committed_value
from sqlalchemy.sql.elements import ColumnElement

from app.models.plugin_state import PluginState
from app.services.plugin_state_store import LEGACY_SYNC_KEY
from app.services.plugin_write_errors import PluginWriteError

_EXPECTED = "plugin_sync_expected_revisions"
_DOCUMENTS = "plugin_sync_original_documents"
_MERGE = "plugin_sync_merge_rows"
_STRICT = "plugin_sync_strict_rows"
_ACK_FENCES = "plugin_sync_ack_fences"
_WRITTEN = "plugin_sync_written_scopes"


def remember_sync_write(
    db: Session, user_id: int, plugin_key: str = LEGACY_SYNC_KEY
) -> None:
    """A revision written in this transaction already fences desired changes."""
    db.info.setdefault(_WRITTEN, set()).add((user_id, plugin_key))


def sync_revision_written(
    db: Session, user_id: int, plugin_key: str = LEGACY_SYNC_KEY
) -> bool:
    return (user_id, plugin_key) in db.info.get(_WRITTEN, set())


def remember_sync_revision(
    db: Session, row: PluginState, *, merge: bool = False
) -> None:
    revision = row.json.get("spec", {}).get("revision", 0)
    if type(revision) is not int or not 0 <= revision < 2**63 - 1:
        raise PluginWriteError("plugin_write_conflict")
    expected = db.info.setdefault(_EXPECTED, {})
    documents = db.info.setdefault(_DOCUMENTS, {})
    if row in db.dirty and row.id in expected:
        return
    if merge and row.id not in db.info.get(_STRICT, set()):
        expected[row.id] = revision
        documents[row.id] = deepcopy(row.json)
        db.info.setdefault(_MERGE, set()).add(row.id)
    else:
        expected.setdefault(row.id, revision)
        documents.setdefault(row.id, deepcopy(row.json))


def require_snapshot_revision(db: Session, row: PluginState) -> None:
    """Keep a complete reconciliation's read fence through its final commit."""
    db.info.setdefault(_STRICT, set()).add(row.id)
    db.info.get(_MERGE, set()).discard(row.id)


def remember_ack_watermark(
    db: Session, row: PluginState, device_id: str, installed_id: int, generation: int
) -> None:
    """Reject a superseded acknowledgement before any device writes commit."""
    path = f"$.spec.devices.{json.dumps(device_id)}"
    fences = db.info.setdefault(_ACK_FENCES, {}).setdefault(row.id, {})
    for key in (
        f"{path}.complete_generation",
        f"{path}.plugins.{json.dumps(str(installed_id))}",
    ):
        fences[key] = min(fences.get(key, generation), generation)


def _merge_patch(before: dict, after: dict) -> dict:
    patch = {key: None for key in before.keys() - after.keys()}
    for key, value in after.items():
        if key in before and before[key] == value:
            continue
        patch[key] = (
            _merge_patch(before.get(key, {}), value)
            if isinstance(value, dict) and isinstance(before.get(key, {}), dict)
            else deepcopy(value)
        )
    return patch


def flush_sync_revision(db: Session, row: PluginState) -> None:
    expected = db.info.get(_EXPECTED, {}).get(row.id)
    if expected is None:
        raise PluginWriteError("plugin_write_conflict")
    if row.id in db.info.get(_MERGE, set()):
        _flush_merge(db, row)
        return
    document = deepcopy(row.json)
    document.setdefault("spec", {})["revision"] = expected + 1
    updated = (
        db.query(PluginState)
        .filter(
            PluginState.id == row.id,
            PluginState.user_id == row.user_id,
            PluginState.plugin_key == row.plugin_key,
            PluginState.installed_kind_id.in_(
                {
                    0,
                    row.installed_kind_id,
                    db.info.get("plugin_state_rebindings", {}).get(
                        row.id, row.installed_kind_id
                    ),
                }
            ),
            func.coalesce(PluginState.json["spec"]["revision"].as_integer(), 0)
            == expected,
        )
        .update(
            {
                PluginState.json: document,
                PluginState.installed_kind_id: row.installed_kind_id,
            },
            synchronize_session=False,
        )
    )
    if updated != 1:
        raise PluginWriteError("plugin_write_conflict")
    db.info[_EXPECTED][row.id] = expected + 1
    db.info[_DOCUMENTS][row.id] = deepcopy(document)
    db.info.get(_ACK_FENCES, {}).pop(row.id, None)
    set_committed_value(row, "json", document)
    set_committed_value(row, "installed_kind_id", row.installed_kind_id)
    remember_sync_write(db, row.user_id, row.plugin_key)


def _flush_merge(db: Session, row: PluginState) -> None:
    """Merge independent intent paths without retrying other plugins' writes."""
    original = db.info[_DOCUMENTS][row.id]
    changes = _merge_patch(original, row.json)
    watermarks = _pop_watermarks(changes)
    patch = json.dumps(changes, separators=(",", ":"))
    merge = (
        func.json_merge_patch
        if db.get_bind().dialect.name == "mysql"
        else func.json_patch
    )
    revision = func.coalesce(PluginState.json["spec"]["revision"].as_integer(), 0)
    maximum = func.greatest if db.get_bind().dialect.name == "mysql" else func.max
    assignments = ["$.spec.revision", revision + 1]
    for path, value in watermarks.items():
        current = _counter_value(path)
        assignments.extend((path, maximum(current, value)))
    identity = (
        PluginState.id == row.id,
        PluginState.user_id == row.user_id,
        PluginState.plugin_key == row.plugin_key,
        PluginState.installed_kind_id.in_(
            {
                0,
                row.installed_kind_id,
                db.info.get("plugin_state_rebindings", {}).get(
                    row.id, row.installed_kind_id
                ),
            }
        ),
    )
    updated = (
        db.query(PluginState)
        .filter(
            *identity,
            *(
                _counter_value(path) <= generation
                for path, generation in db.info.get(_ACK_FENCES, {})
                .get(row.id, {})
                .items()
            ),
        )
        .update(
            {
                PluginState.json: func.json_set(
                    merge(PluginState.json, patch), *assignments
                ),
                PluginState.installed_kind_id: row.installed_kind_id,
            },
            synchronize_session=False,
        )
    )
    if updated != 1:
        raise PluginWriteError("plugin_write_conflict")
    document = db.execute(select(PluginState.json).where(*identity)).scalar_one()
    db.info[_EXPECTED][row.id] = document["spec"]["revision"]
    db.info[_DOCUMENTS][row.id] = deepcopy(document)
    db.info.get(_ACK_FENCES, {}).pop(row.id, None)
    set_committed_value(row, "json", document)
    set_committed_value(row, "installed_kind_id", row.installed_kind_id)
    remember_sync_write(db, row.user_id, row.plugin_key)


def _counter_value(path: str) -> ColumnElement[int]:
    return func.coalesce(cast(func.json_extract(PluginState.json, path), BigInteger), 0)


def _pop_watermarks(changes: dict) -> dict[str, int]:
    """Merge protocol counters against the current row, never a stale document."""
    counters: dict[str, int] = {}

    def take(document: dict, key: str, path: str) -> None:
        if key not in document:
            return
        value = document.pop(key)
        if type(value) is not int or value < 0:
            raise PluginWriteError("plugin_write_conflict")
        counters[path] = value

    spec = changes.get("spec", {})
    take(spec, "generation", "$.spec.generation")
    for device_id, device in spec.get("devices", {}).items():
        path = f"$.spec.devices.{json.dumps(device_id)}"
        take(device, "complete_generation", f"{path}.complete_generation")
        plugins = device.get("plugins", {})
        for installed_id in list(plugins):
            take(plugins, installed_id, f"{path}.plugins.{json.dumps(installed_id)}")
    return counters


def clear_sync_revisions(db: Session) -> None:
    db.info.pop("plugin_state_rebindings", None)
    db.info.pop(_WRITTEN, None)
    db.info.pop(_EXPECTED, None)
    db.info.pop(_DOCUMENTS, None)
    db.info.pop(_MERGE, None)
    db.info.pop(_STRICT, None)
    db.info.pop(_ACK_FENCES, None)
