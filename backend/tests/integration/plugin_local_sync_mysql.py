"""Disposable MySQL verification of upgrade, guarded downgrade and operation recovery."""

import os
import uuid
from contextlib import contextmanager
from unittest.mock import patch

from fastapi import HTTPException
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session

from alembic import command
from alembic.config import Config
from app.core.config import settings
from app.models.kind import Kind
from app.models.plugin_local_sync import PluginLocalSyncOperation
from app.models.user import User
from app.services.device.plugin_sync_protocol import load_versioned_plugin_payload
from app.services.plugin_local_sync import _guard_intent_order
from app.services.plugin_write_coordination import configure_plugin_session


def verify_ordering(engine):
    owner = int(uuid.uuid4().hex[:7], 16) + 100000
    with Session(engine) as db:
        db.add(User(id=owner, user_name=f"local-order-{owner}", password_hash="unused"))
        db.commit()

    @contextmanager
    def session():
        with Session(engine) as db:
            configure_plugin_session(db)
            yield db

    with session() as db:
        _guard_intent_order(db, owner, "native", 17, 9)
        db.commit()
    payload = load_versioned_plugin_payload(
        session,
        user_id=owner,
        load_payload=lambda db: {"mode": "merge", "scope": "plugins", "plugins": []},
        complete=True,
    )
    assert payload["plugin_sync"]["generation"] == 1
    with session() as db:
        try:
            _guard_intent_order(db, owner, "native", 17, 8)
        except HTTPException as error:
            assert error.detail == "INTENT_SUPERSEDED"
            db.rollback()
        else:
            raise AssertionError("A late first-arrival intent advanced the watermark")
        _guard_intent_order(db, owner, "native", 18, 1)
        db.commit()
        _guard_intent_order(db, owner, "other-native", 17, 1)
        db.commit()
        state = (
            db.query(Kind)
            .filter_by(
                user_id=owner,
                kind="PluginSyncState",
                namespace="plugin-sync",
                name="account",
            )
            .one()
        )
        assert state.json["spec"]["localIntentOrders"]["native"]["17"] == 9
    print(
        "MySQL/Redis: intent ordering survives generation writes and isolates plugin/instance scopes"
    )


def verify(engine, url):
    config = Config("alembic.ini")
    with patch.object(
        settings, "DATABASE_URL", url.render_as_string(hide_password=False)
    ):
        # Seed only the old head marker: the new revision must be self-contained
        # and must not assume Device, connector, or other business rows exist.
        command.stamp(config, "f3a7c9e1b2d4")
        command.upgrade(config, "head")
        assert "plugin_local_sync_operations" in inspect(engine).get_table_names()
        assert "plugin_sync_outbox" not in inspect(engine).get_table_names()
        command.downgrade(config, "f3a7c9e1b2d4")
        assert "plugin_local_sync_operations" not in inspect(engine).get_table_names()
        command.upgrade(config, "head")
        verify_ordering(engine)
        original = {"state": "intent_saved", "intentOrder": 7, "plugin": {"id": 17}}
        with Session(engine) as db:
            db.add(
                PluginLocalSyncOperation(
                    user_id=1,
                    instance_id="native",
                    operation_id="uncertain-operation",
                    request_hash="original-hash",
                    action="install",
                    installed_id=17,
                    document=original,
                )
            )
            db.commit()
        with Session(engine) as db:
            saved = db.query(PluginLocalSyncOperation).one()
            assert saved.document == original
            assert saved.operation_id == "uncertain-operation"
            assert saved.request_hash == "original-hash"
        try:
            command.downgrade(config, "f3a7c9e1b2d4")
        except RuntimeError as error:
            assert "Drain and archive" in str(error)
        else:
            raise AssertionError("Downgrade removed a recoverable operation")
        assert "plugin_local_sync_operations" in inspect(engine).get_table_names()
        assert "plugin_sync_outbox" not in inspect(engine).get_table_names()
        with engine.begin() as db:
            db.execute(text("DELETE FROM plugin_local_sync_operations"))
        command.downgrade(config, "f3a7c9e1b2d4")
    print(
        "MySQL: upgrade head, empty downgrade, guarded in-flight downgrade, original operation persistence passed"
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
