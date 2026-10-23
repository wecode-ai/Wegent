"""Compaction removes obsolete automatic history without invalidating live work."""

from datetime import datetime, timedelta

from app.models.kind import Kind
from scripts.compact_plugin_auth_migrations import compact_batch, obsolete_query


def add_row(db, user, offset, *, active=False, expires=1, **overrides):
    row = Kind(
        user_id=user.id,
        kind="ConnectorMigration",
        namespace="plugin-auth",
        name=f"{offset:064x}",
        is_active=active,
        updated_at=datetime(2026, 1, 1) + timedelta(seconds=offset),
        json={
            "spec": {
                "automatic": True,
                "source_identity": "mail",
                "connector_slug": "mail",
                "device_id": "local",
                "expires_at": expires,
            }
        },
    )
    for key, value in overrides.items():
        setattr(row, key, value)
    db.add(row)
    db.flush()
    return row


def test_compaction_keeps_latest_and_live_intents_and_deletes_in_bounded_batches(
    test_db, test_user, test_admin_user
):
    inactive = add_row(test_db, test_user, 1)
    expired = add_row(test_db, test_user, 2, active=True)
    live = add_row(test_db, test_user, 3, active=True, expires=4_000_000_000)
    latest = add_row(test_db, test_user, 4)
    foreign = add_row(test_db, test_admin_user, 5)
    namespace = add_row(test_db, test_user, 6, namespace="other")
    transfer = add_row(test_db, test_user, 7, kind="ConnectorTransfer")
    manual = add_row(test_db, test_user, 8, json={"spec": {"expires_at": 1}})
    device = add_row(test_db, test_user, 9)
    device.json = {"spec": {**device.json["spec"], "device_id": "other"}}
    malformed = add_row(test_db, test_user, 10, json={"spec": {"automatic": True}})
    test_db.flush()
    before = test_db.query(Kind).count()
    inactive_id, expired_id = inactive.id, expired.id

    assert {row.id for row in obsolete_query(test_db, test_user.id, 100)} == {
        inactive.id,
        expired.id,
    }
    assert test_db.query(Kind).count() == before
    assert compact_batch(test_db, test_user.id, 1) == 1
    assert compact_batch(test_db, test_user.id, 1) == 1
    assert compact_batch(test_db, test_user.id, 1) == 0

    remaining = {row.id for row in test_db.query(Kind.id)}
    assert inactive_id not in remaining and expired_id not in remaining
    assert {
        row.id
        for row in (
            live,
            latest,
            foreign,
            namespace,
            transfer,
            manual,
            device,
            malformed,
        )
    } <= remaining
    assert obsolete_query(test_db, test_user.id, 4_000_000_000).one().id == live.id


def test_compaction_ranks_latest_by_update_time_instead_of_insert_id(
    test_db, test_user
):
    latest = add_row(test_db, test_user, 100)
    old = add_row(test_db, test_user, 1)

    assert old.id > latest.id
    assert compact_batch(test_db, test_user.id, 100) == 1
    assert test_db.query(Kind.id).filter(Kind.id == latest.id).one().id == latest.id
    assert compact_batch(test_db, test_user.id, 100) == 0
