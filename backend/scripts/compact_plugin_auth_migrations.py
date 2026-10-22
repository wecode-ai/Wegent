#!/usr/bin/env python3
"""Keep the latest automatic sync row and remove obsolete duplicates.

Run after all backend instances use reusable automatic migration slots:
    uv run python scripts/compact_plugin_auth_migrations.py
    uv run python scripts/compact_plugin_auth_migrations.py --apply

The default is read-only. Live intents, manual intents and ConnectorTransfer
escrow are preserved. Deletions commit in bounded batches under the same user
coordination used by authentication services; rerun after old live intents expire.
"""

import argparse
import sys
import time
from pathlib import Path

from sqlalchemy import func, or_
from sqlalchemy.orm import Query, Session

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.db.session import SessionLocal
from app.models.kind import Kind
from app.models.user import User
from app.services.plugin_account_connections import CONNECTION_NAMESPACE
from app.services.plugin_auth_migrations import MIGRATION_KIND
from app.services.plugin_write_coordination import (
    acquire_plugin_write_lock,
    configure_plugin_session,
)


def migration_query(db: Session) -> Query:
    return db.query(Kind).filter(
        Kind.kind == MIGRATION_KIND,
        Kind.namespace == CONNECTION_NAMESPACE,
        Kind.json["spec"]["automatic"].as_boolean().is_(True),
    )


def obsolete_query(db: Session, user_id: int, now: int) -> Query:
    source = Kind.json["spec"]["source_identity"].as_string()
    connector = Kind.json["spec"]["connector_slug"].as_string()
    device = Kind.json["spec"]["device_id"].as_string()
    ranked = (
        migration_query(db)
        .filter(
            Kind.user_id == user_id,
            source.isnot(None),
            connector.isnot(None),
            device.isnot(None),
        )
        .with_entities(
            Kind.id,
            Kind.is_active,
            Kind.json["spec"]["expires_at"].as_integer().label("expires_at"),
            func.row_number()
            .over(
                partition_by=[source, connector, device],
                order_by=[Kind.updated_at.desc(), Kind.id.desc()],
            )
            .label("position"),
        )
        .subquery()
    )
    return db.query(ranked.c.id).filter(
        ranked.c.position > 1,
        or_(ranked.c.is_active.is_(False), ranked.c.expires_at <= now),
    )


def compact_batch(db: Session, user_id: int, batch_size: int) -> int:
    """The caller owns commit/rollback for this bounded transaction."""
    acquire_plugin_write_lock(db, user_id)
    owner = db.query(User).filter(User.id == user_id).populate_existing().first()
    if owner is None:
        raise ValueError("Migration owner does not exist")
    ids = [
        row.id
        for row in obsolete_query(db, user_id, int(time.time())).limit(batch_size)
    ]
    if not ids:
        return 0
    return (
        migration_query(db)
        .filter(Kind.user_id == user_id, Kind.id.in_(ids))
        .delete(synchronize_session=False)
    )


def positive_int(value: str) -> int:
    result = int(value)
    if result <= 0:
        raise argparse.ArgumentTypeError("must be positive")
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--user-id", type=positive_int)
    parser.add_argument("--batch-size", type=positive_int, default=1000)
    args = parser.parse_args()
    with SessionLocal() as db:
        configure_plugin_session(db)
        query = migration_query(db).with_entities(Kind.user_id).distinct()
        if args.user_id is not None:
            query = query.filter(Kind.user_id == args.user_id)
        user_ids = [row.user_id for row in query.order_by(Kind.user_id)]
        db.rollback()
        total = 0
        for user_id in user_ids:
            if not args.apply:
                count = obsolete_query(db, user_id, int(time.time())).count()
                db.rollback()
            else:
                count = 0
                while True:
                    with db.begin():
                        deleted = compact_batch(db, user_id, args.batch_size)
                    count += deleted
                    if deleted == 0:
                        break
            total += count
            print(f"user_id={user_id} obsolete_rows={count}")
        print(f"mode={'apply' if args.apply else 'dry-run'} total={total}")


if __name__ == "__main__":
    main()
