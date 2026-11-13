"""Real MySQL migration, rollback and plugin-scoped recovery; invoked by CI."""

import os
import uuid
from contextlib import contextmanager
from unittest.mock import patch

from fastapi import HTTPException
from sqlalchemy import create_engine, inspect
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session

from alembic import command
from alembic.config import Config
from app.core.config import settings
from app.models.kind import Kind
from app.models.plugin_state import PluginState
from app.models.user import User
from app.services.device.plugin_sync_protocol import load_versioned_plugin_payload
from app.services.plugin_local_sync import _guard_intent_order
from app.services.plugin_local_sync import _lookup_operation as lookup_operation
from app.services.plugin_state_store import ensure_plugin_state
from app.services.plugin_write_coordination import configure_plugin_session
from app.services.plugin_write_errors import PluginWriteError

PARENT = "f3a7c9e1b2d4"


def verify_ordering(engine):
    @contextmanager
    def session():
        with Session(engine) as db:
            configure_plugin_session(db)
            yield db

    with session() as db:
        _guard_intent_order(db, 1, "native", 17, 9)
        db.commit()
    payload = load_versioned_plugin_payload(
        session,
        user_id=1,
        protocol_version=3,
        complete=True,
        load_payload=lambda db: {"mode": "merge", "scope": "plugins", "plugins": []},
    )
    assert payload["plugin_sync"]["complete"] is False
    assert set(payload["plugin_sync"]["revisions"]) == {"17", "18"}
    with session() as db:
        try:
            _guard_intent_order(db, 1, "native", 17, 8)
        except HTTPException as error:
            assert error.detail == "INTENT_SUPERSEDED"
            db.rollback()
        else:
            raise AssertionError("A late first-arrival intent advanced the watermark")
        _guard_intent_order(db, 1, "native", 18, 1)
        db.commit()
        _guard_intent_order(db, 1, "other-native", 17, 1)
        db.commit()
        states = {
            row.installed_kind_id: row
            for row in db.query(PluginState)
            .filter(PluginState.installed_kind_id > 0)
            .all()
        }
        assert states[17].json["spec"]["localIntentOrders"]["native"]["17"] == 9
        assert states[18].json["spec"]["localIntentOrders"]["native"]["18"] == 1
        assert "18" not in states[17].json["spec"]["localIntentOrders"]["native"]


def verify(engine, url):
    config = Config("alembic.ini")
    original = {
        "operationId": "uncertain-operation",
        "intentOrder": 7,
        "installedId": 17,
        "requestHash": "original-hash",
        "installedRevision": 1,
        "action": "install",
    }
    User.__table__.create(engine)
    Kind.__table__.create(engine)
    with Session(engine) as db, db.begin():
        db.add_all(
            [
                User(id=owner, user_name=f"local-sync-{owner}", password_hash="unused")
                for owner in (1, 2)
            ]
        )
        for identity in (17, 18):
            db.add(
                Kind(
                    id=identity,
                    user_id=1,
                    kind="InstalledPlugin",
                    namespace="default",
                    name=f"plugin-{identity}",
                    is_active=False,
                    json={"spec": {"revision": 1}},
                )
            )
        db.add(
            Kind(
                user_id=1,
                kind="PluginSyncState",
                namespace="plugin-sync",
                name="account",
                is_active=True,
                json={
                    "spec": {
                        "revision": 3,
                        "generation": 9,
                        "localIntents": {"native": {"17": original}},
                        "localIntentOrders": {"native": {"17": 7}},
                    }
                },
            )
        )
    before = set(inspect(engine).get_table_names()) | {"alembic_version"}
    with patch.object(
        settings, "DATABASE_URL", url.render_as_string(hide_password=False)
    ):
        command.stamp(config, PARENT)
        with engine.begin() as db:
            db.execute(
                Kind.__table__.update().where(Kind.id == 18).values(name="plugin-17 ")
            )
        command.upgrade(config, "head")
        assert set(inspect(engine).get_table_names()) == before | {"plugin_states"}
        with Session(engine) as db:
            configure_plugin_session(db)
            assert db.query(PluginState).count() == 0
            try:
                ensure_plugin_state(db, 1, "plugin-17", installed_kind_id=17)
            except PluginWriteError as error:
                assert error.code == "plugin_write_conflict"
                db.rollback()
            else:
                raise AssertionError(
                    "MySQL-equivalent identities were not rejected on first use"
                )
            assert db.query(PluginState).count() == 0
        with engine.begin() as db:
            db.execute(
                Kind.__table__.update().where(Kind.id == 18).values(name="plugin-18")
            )
        with Session(engine) as db:
            assert lookup_operation(db, 1, "native", "uncertain-operation") == original
            assert lookup_operation(db, 2, "native", "uncertain-operation") is None
            assert (
                lookup_operation(db, 1, "other-native", "uncertain-operation") is None
            )
            assert db.query(Kind).filter_by(kind="PluginSyncState").count() == 1
            assert db.query(PluginState).count() == 0
        verify_ordering(engine)
        command.downgrade(config, PARENT)
        assert set(inspect(engine).get_table_names()) == before
        with Session(engine) as db:
            restored = db.query(Kind).filter_by(kind="PluginSyncState", user_id=1).one()
            assert restored.json["spec"]["localIntentOrders"]["native"]["17"] == 9
            assert restored.json["spec"]["localIntents"]["native"]["17"] == original
        command.upgrade(config, "head")
        with Session(engine) as db:
            assert lookup_operation(db, 1, "native", "uncertain-operation") == original
    print(
        "MySQL: one new table, migration/rollback, durable receipts and independent plugin ordering passed"
    )


def main():
    url = make_url(os.environ["PLUGIN_LOCAL_SYNC_TEST_MYSQL_URL"])
    if url.get_backend_name() != "mysql" or url.host not in {
        "mysql",
        "127.0.0.1",
        "localhost",
    }:
        raise ValueError("An explicit disposable loopback/CI MySQL URL is required")
    database = "test_plugin_local_sync_" + uuid.uuid4().hex
    admin = create_engine(url.set(database=None), isolation_level="AUTOCOMMIT")
    engine = None
    try:
        with admin.connect() as db:
            db.exec_driver_sql(f"CREATE DATABASE `{database}`")
        target = url.set(database=database)
        engine = create_engine(target)
        verify(engine, target)
    finally:
        if engine is not None:
            engine.dispose()
        with admin.connect() as db:
            db.exec_driver_sql(f"DROP DATABASE IF EXISTS `{database}`")
        admin.dispose()


if __name__ == "__main__":
    main()
