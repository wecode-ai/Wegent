"""Upgrade and rollback preserve plugin ordering without changing shared indexes."""

import importlib.util
from copy import deepcopy
from pathlib import Path

import pytest
import sqlalchemy as sa
from sqlalchemy.orm import Session

from alembic.migration import MigrationContext
from alembic.operations import Operations
from app.models.kind import Kind
from app.services.plugin_state_store import ensure_plugin_state
from app.services.plugin_write_errors import PluginWriteError


def migration(connection):
    path = (
        Path(__file__).parents[3]
        / "backend-rs/migrations/reference/versions/20261113_a5b6c7d8e9f0_add_plugin_states.py"
    )
    spec = importlib.util.spec_from_file_location("plugin_states_migration", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.op = Operations(MigrationContext.configure(connection))
    return module


def seed(connection, *, duplicate=False):
    document = {
        "spec": {
            "generation": 10,
            "revision": 12,
            "devices": {
                "desktop": {"complete_generation": 8, "plugins": {"11": 10, "12": 9}}
            },
            "creationRevisions": {"plugin-a": 2, "plugin-b": 3},
            "localIntents": {
                "instance": {
                    "11": {"operationId": "op-a", "intentOrder": 4},
                    "12": {"operationId": "op-b", "intentOrder": 5},
                }
            },
            "localIntentOrders": {"instance": {"11": 4, "12": 5}},
        }
    }
    rows = [
        dict(
            id=11,
            user_id=151,
            kind="InstalledPlugin",
            namespace="default",
            name="plugin-a",
            json={"spec": {"revision": 2}},
            is_active=True,
        ),
        dict(
            id=12,
            user_id=151,
            kind="InstalledPlugin",
            namespace="default",
            name="plugin-b",
            json={"spec": {"revision": 3}},
            is_active=False,
        ),
        dict(
            id=13,
            user_id=151,
            kind="PluginSyncState",
            namespace="plugin-sync",
            name="account",
            json=document,
            is_active=True,
        ),
    ]
    if duplicate:
        rows.append({**rows[-1], "id": 14})
    connection.execute(Kind.__table__.insert(), rows)
    return document


def test_upgrade_and_downgrade_preserve_watermarks_and_latest_receipts():
    engine = sa.create_engine("sqlite://")
    Kind.__table__.create(engine)
    with engine.begin() as connection:
        document = seed(connection)
        original_indexes = sa.inspect(connection).get_indexes("kinds")
        change = migration(connection)
        change.upgrade()
        states = sa.Table("plugin_states", sa.MetaData(), autoload_with=connection)
        assert connection.scalar(sa.select(sa.func.count()).select_from(states)) == 0
        assert (
            connection.execute(
                sa.select(Kind.json).where(Kind.kind == "PluginSyncState")
            ).scalar_one()
            == document
        )
        with Session(connection, join_transaction_mode="create_savepoint") as db:
            ensure_plugin_state(db, 151, "plugin-a", installed_kind_id=11)
            ensure_plugin_state(db, 151, "plugin-b", installed_kind_id=12)
            ensure_plugin_state(db, 151, "@legacy-v2")
            db.commit()
        rows = {
            row["plugin_key"]: row
            for row in connection.execute(sa.select(states)).mappings()
        }
        assert set(rows) == {"@legacy-v2", "plugin-a", "plugin-b"}
        assert rows["plugin-a"]["installed_kind_id"] == 11
        assert rows["plugin-b"]["installed_kind_id"] == 12
        assert rows["plugin-a"]["json"]["spec"]["localIntentOrders"] == {
            "instance": {"11": 4}
        }
        assert rows["plugin-b"]["json"]["spec"]["devices"] == {
            "desktop": {"complete_generation": 8, "plugins": {"12": 9}}
        }
        assert rows["@legacy-v2"]["json"] == document
        assert sa.inspect(connection).get_indexes("kinds") == original_indexes
        assert (
            connection.scalar(
                sa.select(sa.func.count())
                .select_from(Kind.__table__)
                .where(Kind.kind == "PluginSyncState")
            )
            == 1
        )

        changed = deepcopy(rows["plugin-a"]["json"])
        changed["spec"]["generation"] = 25
        changed["spec"]["localIntentOrders"]["instance"]["11"] = 6
        changed["spec"]["localIntents"]["instance"]["11"] = {
            "operationId": "after-upgrade",
            "intentOrder": 6,
        }
        connection.execute(
            states.update()
            .where(states.c.id == rows["plugin-a"]["id"])
            .values(json=changed)
        )
        change.downgrade()

        assert not sa.inspect(connection).has_table("plugin_states")
        restored = connection.execute(
            sa.select(Kind.json).where(Kind.kind == "PluginSyncState")
        ).scalar_one()
        assert restored["spec"]["generation"] == 25
        assert restored["spec"]["localIntentOrders"] == {"instance": {"11": 6, "12": 5}}
        assert (
            restored["spec"]["localIntents"]["instance"]["11"]["operationId"]
            == "after-upgrade"
        )
        assert restored["spec"]["devices"] == document["spec"]["devices"]
        change.upgrade()
        assert sa.inspect(connection).has_table("plugin_states")
    engine.dispose()


def test_schema_only_upgrade_preserves_ambiguous_history_until_first_use():
    engine = sa.create_engine("sqlite://")
    Kind.__table__.create(engine)
    with engine.begin() as connection:
        seed(connection, duplicate=True)
        migration(connection).upgrade()
        assert sa.inspect(connection).has_table("plugin_states")
        with (
            Session(connection, join_transaction_mode="create_savepoint") as db,
            pytest.raises(PluginWriteError),
        ):
            ensure_plugin_state(db, 151, "plugin-a", installed_kind_id=11)
        assert (
            connection.scalar(sa.select(sa.func.count()).select_from(Kind.__table__))
            == 4
        )
    engine.dispose()


def test_rollback_without_initialized_state_does_not_touch_ambiguous_history():
    engine = sa.create_engine("sqlite://")
    Kind.__table__.create(engine)
    with engine.begin() as connection:
        seed(connection, duplicate=True)
        before = connection.execute(sa.select(Kind.__table__)).mappings().all()
        change = migration(connection)
        change.upgrade()
        change.downgrade()
        assert not sa.inspect(connection).has_table("plugin_states")
        assert connection.execute(sa.select(Kind.__table__)).mappings().all() == before
    engine.dispose()


@pytest.mark.parametrize("value", [None, True, -1, "10", 2**63 - 1])
def test_invalid_counter_is_preserved_by_upgrade_and_refused_on_first_use(value):
    engine = sa.create_engine("sqlite://")
    Kind.__table__.create(engine)
    with engine.begin() as connection:
        document = seed(connection)
        document["spec"]["generation"] = value
        connection.execute(
            Kind.__table__.update()
            .where(Kind.kind == "PluginSyncState")
            .values(json=document)
        )
        migration(connection).upgrade()
        assert sa.inspect(connection).has_table("plugin_states")
        with (
            Session(connection, join_transaction_mode="create_savepoint") as db,
            pytest.raises(PluginWriteError),
        ):
            ensure_plugin_state(db, 151, "plugin-a", installed_kind_id=11)
    engine.dispose()
