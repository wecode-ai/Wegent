"""Create catalog identities before taking row locks."""

from typing import Any

from sqlalchemy.dialects.mysql import insert as mysql_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session

from app.models.plugin_marketplace import Plugin


def ensure_catalog_plugin(db: Session, values: dict[str, Any]) -> Plugin:
    """Atomically create an identity, then lock its existing row without gap locks."""
    identity = {
        "catalog_namespace": values["catalog_namespace"],
        "slug": values["slug"],
    }
    db.flush()
    if db.get_bind().dialect.name == "mysql":
        statement = mysql_insert(Plugin).values(**values)
        statement = statement.on_duplicate_key_update(id=Plugin.id)
    else:
        statement = sqlite_insert(Plugin).values(**values)
        statement = statement.on_conflict_do_nothing(index_elements=list(identity))
    db.execute(statement)
    return (
        db.query(Plugin)
        .filter_by(**identity)
        .with_for_update()
        .populate_existing()
        .one()
    )
