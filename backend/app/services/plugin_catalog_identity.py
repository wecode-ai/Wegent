"""Create missing catalog identities before taking row locks."""

from typing import Any

from sqlalchemy.dialects.mysql import insert as mysql_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session

from app.models.plugin_marketplace import Plugin


def ensure_catalog_plugin(db: Session, values: dict[str, Any]) -> Plugin:
    """Insert missing identities, then lock and refresh their current rows."""
    identity = {
        "catalog_namespace": values["catalog_namespace"],
        "slug": values["slug"],
    }
    db.flush()
    # Duplicate secondary-key upserts take next-key locks in InnoDB, so existing
    # identities must skip the insert without locking a potentially missing row.
    if db.query(Plugin.id).filter_by(**identity).first() is None:
        if db.get_bind().dialect.name == "mysql":
            statement = mysql_insert(Plugin).values(**values)
            statement = statement.on_duplicate_key_update(id=Plugin.id)
        else:
            statement = sqlite_insert(Plugin).values(**values)
            statement = statement.on_conflict_do_nothing(index_elements=list(identity))
        db.execute(statement)
    # The locking read sees current state even when the probe used an RR snapshot.
    return (
        db.query(Plugin)
        .filter_by(**identity)
        .with_for_update()
        .populate_existing()
        .one()
    )
