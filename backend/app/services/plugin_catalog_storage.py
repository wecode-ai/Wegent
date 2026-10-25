# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Row-scoped persistence for system-owned plugin catalog identities."""

from typing import Any

from sqlalchemy.dialects.mysql import insert as mysql_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.plugin_marketplace import Plugin, PluginRelease


def lock_catalog_plugin(
    db: Session,
    *,
    catalog_namespace: str,
    slug: str,
    initial_values: dict[str, Any],
) -> Plugin:
    """Create before locking so absent identities never acquire gap locks."""
    identity = {"catalog_namespace": catalog_namespace, "slug": slug}
    db.flush()
    if db.get_bind().dialect.name == "mysql":
        statement = mysql_insert(Plugin).values(**identity, **initial_values)
        statement = statement.on_duplicate_key_update(id=Plugin.id)
    else:
        statement = sqlite_insert(Plugin).values(**identity, **initial_values)
        statement = statement.on_conflict_do_nothing(index_elements=list(identity))
    db.execute(statement)
    return (
        db.query(Plugin)
        .filter_by(**identity)
        .with_for_update()
        .populate_existing()
        .one()
    )


def create_or_lock_plugin_release(
    db: Session, initial_values: dict[str, Any]
) -> tuple[PluginRelease, bool]:
    """Insert without gap locks, resolving an existing unique version in-place."""
    identity = {
        "plugin_id": initial_values["plugin_id"],
        "version": initial_values["version"],
    }
    if db.get_bind().dialect.name == "sqlite":
        statement = sqlite_insert(PluginRelease).values(**initial_values)
        result = db.execute(
            statement.on_conflict_do_nothing(index_elements=list(identity))
        )
        release = (
            db.query(PluginRelease).filter_by(**identity).populate_existing().one()
        )
        return release, result.rowcount == 1
    candidate = PluginRelease(**initial_values)
    try:
        with db.begin_nested():
            db.add(candidate)
            db.flush()
    except IntegrityError as error:
        if not error.orig.args or error.orig.args[0] != 1062:
            raise
        existing = (
            db.query(PluginRelease)
            .filter_by(**identity)
            .with_for_update()
            .populate_existing()
            .one_or_none()
        )
        if existing is None:
            raise
        return existing, False
    return candidate, True
