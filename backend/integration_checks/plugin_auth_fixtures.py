"""Shared real MySQL/Redis fixtures for plugin authentication transaction tests."""

import os
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Callable

import pytest
from pydantic import SecretStr
from redis import Redis
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session, sessionmaker

from app.models.kind import Kind
from app.models.skill_binary import SkillBinary
from app.models.user import User
from app.schemas.plugin_account_auth import (
    PluginCredentialWrite,
    PluginMigrationCreate,
    PluginNativeEnrollment,
)
from app.services import plugin_write_coordination as coordination
from app.services.plugin_account_connections import (
    PluginAccountAuthError,
    PluginAccountConnectionService,
)
from app.services.plugin_auth_transfers import PluginAuthTransferService
from app.services.plugin_credential_cipher import PluginCredentialCipher
from app.services.plugin_write_coordination import configure_plugin_session
from app.services.plugin_write_resources import close_plugin_write_resources

CREDENTIAL = SecretStr(
    '{"access_token":"synthetic-access","refresh_token":"synthetic-refresh"}'
)


@dataclass
class Context:
    sessions: sessionmaker
    user_id: int
    plugin_id: int
    device_id: str
    accounts: PluginAccountConnectionService
    transfers: PluginAuthTransferService

    def credential(self) -> PluginCredentialWrite:
        return PluginCredentialWrite(
            installed_plugin_id=self.plugin_id,
            connector_slug="test",
            account_id="synthetic-account",
            credential=CREDENTIAL,
            expected_revision=0,
        )

    def ticket(self) -> PluginNativeEnrollment:
        with self.sessions.begin() as db:
            ticket = self.transfers.migrations.create(
                db,
                user_id=self.user_id,
                request=PluginMigrationCreate(
                    installed_plugin_id=self.plugin_id,
                    connector_slug="test",
                    device_id=self.device_id,
                    expected_revision=0,
                ),
            )
            return PluginNativeEnrollment(
                migration_id=ticket.id,
                account_id="synthetic-account",
                credential=CREDENTIAL,
            )

    def stage(self, db: Session, ticket: PluginNativeEnrollment) -> dict:
        return self.transfers.stage(
            db, user_id=self.user_id, device_id=self.device_id, request=ticket
        )

    def transfer_action(self, db: Session, ticket: PluginNativeEnrollment, action: str):
        return getattr(self.transfers, action)(
            db,
            user_id=self.user_id,
            device_id=self.device_id,
            migration_id=ticket.migration_id,
        )


@pytest.fixture(scope="module")
def sessions():
    url = make_url(os.environ["PLUGIN_AUTH_MYSQL_TEST_URL"])
    assert url.get_backend_name() == "mysql"
    assert url.host in {"127.0.0.1", "localhost"}
    assert url.database == "plugin_auth_test", "Use only the dedicated test database"
    engine = create_engine(url, isolation_level="REPEATABLE READ", pool_size=4)
    with engine.connect() as db:
        assert db.scalar(text("SELECT @@transaction_isolation")) == "REPEATABLE-READ"
    for table in (
        User.__table__,
        Kind.__table__,
        SkillBinary.__table__,
    ):
        table.create(engine, checkfirst=True)
    with Session(engine) as db, db.begin():
        # This disposable database starts without the old policy index.
        assert not db.scalar(
            text(
                "SELECT COUNT(*) FROM information_schema.statistics "
                "WHERE table_schema = DATABASE() AND table_name = 'kinds' "
                "AND index_name = 'uq_kinds_account_auth_policy'"
            )
        )
    raw_redis_url = os.environ["PLUGIN_AUTH_REDIS_TEST_URL"]
    redis_url = make_url(raw_redis_url)
    assert redis_url.host in {"127.0.0.1", "localhost"}
    assert redis_url.database == "15", "Use only the dedicated test Redis DB 15"
    client = Redis.from_url(raw_redis_url, socket_timeout=2)
    assert client.ping()

    class PluginAuthSession(Session):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            configure_plugin_session(self)

    try:
        with pytest.MonkeyPatch.context() as patch:
            patch.setattr(coordination, "_redis_client", lambda: client)
            yield sessionmaker(engine, class_=PluginAuthSession, expire_on_commit=False)
    finally:
        try:
            client.close()
        finally:
            try:
                close_plugin_write_resources()
            finally:
                engine.dispose()


@contextmanager
def created_context(sessions):
    with sessions.begin() as db:
        user = User(user_name=f"auth-test-{uuid.uuid4().hex}", password_hash="unused")
        db.add(user)
        db.flush()
        plugin = Kind(
            user_id=user.id,
            kind="InstalledPlugin",
            namespace="default",
            name="mysql-auth-fixture",
            json={
                "spec": {
                    "source": {
                        "type": "marketplace",
                        "providerKey": "test",
                        "pluginKey": "mysql-auth-fixture",
                        "catalogItemId": "1",
                    },
                    "packageRef": {"checksum": "sha256:" + "a" * 64},
                    "components": {
                        "connectors": [
                            {
                                "slug": "test",
                                "accountAuth": {
                                    "protocolVersion": 1,
                                    "credentialType": "oauth2",
                                    "adapter": "scripts/auth.py",
                                    "exportMode": "exclusive",
                                    "oauth2": ["refresh", "revoke"],
                                },
                            }
                        ]
                    },
                }
            },
        )
        device = Kind(
            user_id=user.id,
            kind="Device",
            namespace="default",
            name="local-test",
            json={
                "spec": {
                    "deviceType": "local",
                    "deviceId": "runtime-test",
                    "runtimeInstanceId": "instance-test",
                }
            },
        )
        db.add_all([plugin, device])
        db.flush()
        accounts = PluginAccountConnectionService(
            PluginCredentialCipher("test", {"test": b"a" * 32})
        )
        value = Context(
            sessions,
            user.id,
            plugin.id,
            device.name,
            accounts,
            PluginAuthTransferService(accounts),
        )
    try:
        yield value
    finally:
        coordination._redis_client().delete(f"wegent:plugin-write:{value.user_id}")
        with sessions.begin() as db:
            db.query(Kind).filter(Kind.user_id == value.user_id).delete()
            db.query(User).filter(User.id == value.user_id).delete()


def establish_snapshot(db: Session, context: Context) -> None:
    # Authentication reads may precede coordination; each later read must be fresh.
    assert db.query(User.id).filter(User.id == context.user_id).scalar() is not None
    assert db.scalar(text("SELECT @@transaction_isolation")) == "READ-COMMITTED"


def race(context: Context, *operations: Callable[[Session], object]) -> list[str]:
    barrier = threading.Barrier(len(operations), timeout=10)

    def execute(operation):
        with context.sessions() as db:
            establish_snapshot(db, context)
            barrier.wait()
            try:
                operation(db)
                db.commit()
                return "ok"
            except PluginAccountAuthError as error:
                db.rollback()
                return error.code

    with ThreadPoolExecutor(max_workers=len(operations)) as pool:
        return sorted(pool.map(execute, operations))


@pytest.fixture
def context(sessions):
    with created_context(sessions) as value:
        yield value


@pytest.fixture
def context_factory(sessions):
    return lambda: created_context(sessions)
