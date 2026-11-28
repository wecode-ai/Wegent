"""Verify recovery using only existing Kind tables and an unchanged migration head."""

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
from app.models.user import User
from app.services.device.plugin_sync_protocol import (
    load_versioned_plugin_payload,
    lock_plugin_sync_state,
)
from app.services.plugin_local_sync import _guard_intent_order
from app.services.plugin_local_sync import _lookup_operation as lookup_operation
from app.services.plugin_write_coordination import configure_plugin_session
from tests.integration.secure_share_tokens_mysql import create_legacy_share_links


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
        # Include the historical table consumed by later share-token migrations;
        # a two-table fixture stamped at an old head is not a valid upgrade input.
        User.__table__.create(engine)
        Kind.__table__.create(engine)
        create_legacy_share_links(engine)
        command.stamp(config, "f3a7c9e1b2d4")
        tables = set(inspect(engine).get_table_names())
        command.upgrade(config, "head")
        assert set(inspect(engine).get_table_names()) == tables
        assert "plugin_local_sync_operations" not in tables
        assert "plugin_sync_outbox" not in tables
        verify_ordering(engine)
        original = {
            "operationId": "uncertain-operation",
            "intentOrder": 7,
            "installedId": 17,
            "requestHash": "original-hash",
            "installedRevision": 1,
            "action": "install",
        }
        with Session(engine) as db:
            configure_plugin_session(db)
            state = lock_plugin_sync_state(db, 1)
            state.json = {
                "spec": {"generation": 0, "localIntents": {"native": {"17": original}}}
            }
            db.commit()
        command.upgrade(config, "head")
        with Session(engine) as db:
            assert lookup_operation(db, 1, "native", "uncertain-operation") == original
            assert lookup_operation(db, 2, "native", "uncertain-operation") is None
            assert (
                lookup_operation(db, 1, "other-native", "uncertain-operation") is None
            )
            assert db.query(Kind).filter_by(namespace="plugin-local-sync").count() == 0
        assert set(inspect(engine).get_table_names()) == tables
    print(
        "MySQL: unchanged schema/head, existing account marker recovery and identity isolation passed"
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
