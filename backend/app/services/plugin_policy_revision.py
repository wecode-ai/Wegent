"""Optimistic transaction versions on the existing account-auth policy.

The real policy is the common business parent of a user's plugin writes.
Materializing its existing default removes the missing-parent race without
introducing a coordination resource or changing account-auth preferences.
"""

import logging
from dataclasses import dataclass
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.dialects.mysql import insert as mysql_insert
from sqlalchemy.engine import Connection, Row
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from app.models.kind import Kind
from app.services.plugin_write_errors import PluginWriteError
from app.services.plugin_write_resources import policy_engine

POLICY_KIND = "ConnectorAuthPolicy"
POLICY_NAMESPACE = "plugin-auth"
POLICY_NAME = "account"
MAX_REVISION = 2**63 - 1
logger = logging.getLogger(__name__)


@dataclass
class PolicyRevision:
    row_id: int
    user_id: int
    revision: int


def _identity(user_id: int) -> tuple[ColumnElement[bool], ...]:
    return (
        Kind.user_id == user_id,
        Kind.kind == POLICY_KIND,
        Kind.namespace == POLICY_NAMESPACE,
        Kind.name == POLICY_NAME,
    )


def _load(db: Session, user_id: int) -> Row[tuple[int, Any, bool]] | None:
    with db.no_autoflush:
        return db.execute(
            select(Kind.id, Kind.json, Kind.is_active).where(*_identity(user_id))
        ).one_or_none()


def read_policy_revision(db: Session, user_id: int) -> PolicyRevision:
    """Read the first version before any business reads or writes."""
    row = _load(db, user_id)
    if row is None:
        _materialize_default(db, user_id)
        row = _load(db, user_id)
    if row is None or row.is_active is not True:
        raise PluginWriteError("plugin_write_conflict")
    payload = row.json
    if not isinstance(payload, dict) or not isinstance(payload.get("spec"), dict):
        raise PluginWriteError("plugin_write_conflict")
    revision = payload["spec"].get("revision", 0)
    if type(revision) is not int or not 0 <= revision < MAX_REVISION:
        raise PluginWriteError("plugin_write_conflict")
    return PolicyRevision(row.id, user_id, revision)


def _materialize_default(db: Session, user_id: int) -> None:
    values = {
        "user_id": user_id,
        "kind": POLICY_KIND,
        "namespace": POLICY_NAMESPACE,
        "name": POLICY_NAME,
        "is_active": True,
        "json": {"spec": {"enabled": True, "revision": 0}},
    }
    bind = db.get_bind()
    if bind.dialect.name != "mysql":
        # SQLite unit sessions may already own uncommitted fixture records.
        # Keep materialization on that transaction, with its real unique index.
        db.execute(Kind.__table__.insert().values(**values))
        return
    engine = bind.engine if isinstance(bind, Connection) else bind
    with policy_engine(engine).begin() as connection:
        statement = mysql_insert(Kind.__table__).values(**values)
        connection.execute(statement.on_duplicate_key_update(id=Kind.id))


def advance_policy_revision(
    db: Session, expected: PolicyRevision, *, enabled: bool | None = None
) -> None:
    """Atomically protect all dependent records in the same transaction."""
    if expected.revision >= MAX_REVISION:
        raise PluginWriteError("plugin_write_conflict")
    revision = func.coalesce(Kind.json["spec"]["revision"].as_integer(), 0)
    payload = func.json_set(Kind.json, "$.spec.revision", expected.revision + 1)
    if enabled is not None:
        row = _load(db, expected.user_id)
        if row is None:
            raise PluginWriteError("plugin_write_conflict")
        payload = {
            **row.json,
            "spec": {
                **row.json.get("spec", {}),
                "enabled": enabled,
                "revision": expected.revision + 1,
            },
        }
    updated = (
        db.query(Kind)
        .filter(
            Kind.id == expected.row_id,
            *_identity(expected.user_id),
            Kind.is_active.is_(True),
            revision == expected.revision,
        )
        .update({Kind.json: payload}, synchronize_session=False)
    )
    if updated != 1:
        logger.warning(
            "Plugin write revision conflict user_id=%s expected_revision=%s",
            expected.user_id,
            expected.revision,
        )
        raise PluginWriteError("plugin_write_conflict")
    expected.revision += 1
