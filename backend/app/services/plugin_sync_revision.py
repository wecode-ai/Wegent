"""Optimistic writes for the existing account synchronization document.

Every desired-state mutation touches this revision in its transaction. Snapshot
builders read it before loading plugins, then CAS it with their generation so a
later generation cannot describe an earlier committed installation state.
"""

import json
import logging
from copy import deepcopy

from redis.exceptions import RedisError
from sqlalchemy import BigInteger, cast, func, select
from sqlalchemy.engine import Connection
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import set_committed_value

from app.core.distributed_lock import DistributedLockUnavailableError
from app.models.kind import Kind
from app.services.plugin_write_errors import PluginWriteError

_EXPECTED = "plugin_sync_expected_revisions"
_DOCUMENTS = "plugin_sync_original_documents"
_MERGE = "plugin_sync_merge_rows"
logger = logging.getLogger(__name__)


def remember_sync_revision(db: Session, row: Kind, *, merge: bool = False) -> None:
    revision = row.json.get("spec", {}).get("revision", 0)
    if type(revision) is not int or not 0 <= revision < 2**63 - 1:
        raise PluginWriteError("plugin_write_conflict")
    expected = db.info.setdefault(_EXPECTED, {})
    documents = db.info.setdefault(_DOCUMENTS, {})
    if merge:
        expected[row.id] = revision
        documents[row.id] = deepcopy(row.json)
        db.info.setdefault(_MERGE, set()).add(row.id)
    else:
        expected.setdefault(row.id, revision)
        documents.setdefault(row.id, deepcopy(row.json))


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


def flush_sync_revision(db: Session, row: Kind) -> None:
    expected = db.info.get(_EXPECTED, {}).get(row.id)
    if expected is None:
        raise PluginWriteError("plugin_write_conflict")
    if row.id in db.info.get(_MERGE, set()):
        _flush_merge(db, row)
        return
    document = deepcopy(row.json)
    document.setdefault("spec", {})["revision"] = expected + 1
    updated = (
        db.query(Kind)
        .filter(
            Kind.id == row.id,
            Kind.user_id == row.user_id,
            Kind.kind == "PluginSyncState",
            Kind.namespace == "plugin-sync",
            Kind.name == "account",
            func.coalesce(Kind.json["spec"]["revision"].as_integer(), 0) == expected,
        )
        .update({Kind.json: document}, synchronize_session=False)
    )
    if updated != 1:
        raise PluginWriteError("plugin_write_conflict")
    db.info[_EXPECTED][row.id] = expected + 1
    db.info[_DOCUMENTS][row.id] = deepcopy(document)
    set_committed_value(row, "json", document)


def _flush_merge(db: Session, row: Kind) -> None:
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
    revision = func.coalesce(Kind.json["spec"]["revision"].as_integer(), 0)
    maximum = func.greatest if db.get_bind().dialect.name == "mysql" else func.max
    assignments = ["$.spec.revision", revision + 1]
    for path, value in watermarks.items():
        current = func.coalesce(cast(func.json_extract(Kind.json, path), BigInteger), 0)
        assignments.extend((path, maximum(current, value)))
    identity = (
        Kind.id == row.id,
        Kind.user_id == row.user_id,
        Kind.kind == "PluginSyncState",
        Kind.namespace == "plugin-sync",
        Kind.name == "account",
        Kind.is_active.is_(True),
    )
    updated = (
        db.query(Kind)
        .filter(*identity)
        .update(
            {Kind.json: func.json_set(merge(Kind.json, patch), *assignments)},
            synchronize_session=False,
        )
    )
    if updated != 1:
        raise PluginWriteError("plugin_write_conflict")
    document = db.execute(select(Kind.json).where(*identity)).scalar_one()
    db.info[_EXPECTED][row.id] = document["spec"]["revision"]
    db.info[_DOCUMENTS][row.id] = deepcopy(document)
    set_committed_value(row, "json", document)


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
    db.info.pop(_EXPECTED, None)
    db.info.pop(_DOCUMENTS, None)
    db.info.pop(_MERGE, None)


def materialize_sync_state(db: Session, user_id: int, document: dict) -> None:
    """Bootstrap once under a short metadata lease, never the plugin write lease."""
    values = dict(
        user_id=user_id,
        kind="PluginSyncState",
        namespace="plugin-sync",
        name="account",
        json=document,
        is_active=True,
    )
    bind = db.get_bind()
    if bind.dialect.name != "mysql" and (
        db.info.get("plugin_write_leases")
        or isinstance(bind, Connection)
        or bind.url.database in {None, ":memory:"}
    ):
        db.add(Kind(**values))
        db.flush()
        return

    from app.core.distributed_lock import distributed_lock
    from app.services.plugin_write_resources import policy_engine, redis_client

    try:
        lock = distributed_lock.owned_lock(
            f"wegent:plugin-write:{user_id}:@sync-init",
            expire_seconds=30,
            blocking_timeout=3,
            redis_client=redis_client(),
        )
        if not lock.acquire():
            raise PluginWriteError("plugin_write_busy")
    except (RedisError, DistributedLockUnavailableError):
        raise PluginWriteError("plugin_write_unavailable") from None
    try:
        engine = bind.engine if isinstance(bind, Connection) else bind
        initial_engine = (
            policy_engine(engine) if bind.dialect.name == "mysql" else engine
        )
        with Session(initial_engine) as initial, initial.begin():
            existing = (
                initial.query(Kind.id)
                .filter_by(
                    user_id=user_id,
                    kind="PluginSyncState",
                    namespace="plugin-sync",
                    name="account",
                    is_active=True,
                )
                .first()
            )
            if existing is None:
                initial.add(Kind(**values))
    finally:
        try:
            lock.release()
        except RedisError:
            logger.warning(
                "Plugin sync initialization lease release failed user_id=%s", user_id
            )
