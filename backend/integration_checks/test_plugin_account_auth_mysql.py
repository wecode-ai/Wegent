"""Real InnoDB transaction races; requires a disposable plugin_auth_test database."""

import json
import os
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Callable

import pytest
from pydantic import SecretStr
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session, sessionmaker

from app.models.kind import Kind
from app.models.user import User
from app.schemas.plugin_account_auth import (
    PluginCredentialWrite,
    PluginMigrationCreate,
    PluginNativeEnrollment,
    PluginNativeExecution,
    PluginOAuthFinish,
)
from app.services.device_service import device_service
from app.services.plugin_account_connections import (
    PluginAccountAuthError,
    PluginAccountConnectionService,
)
from app.services.plugin_auth_execution import PluginAuthExecutionService
from app.services.plugin_auth_transfers import PluginAuthTransferService
from app.services.plugin_credential_cipher import PluginCredentialCipher
from app.services.plugin_oauth_operations import PluginOAuthOperations

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
    for table in (User.__table__, Kind.__table__):
        table.create(engine, checkfirst=True)
    yield sessionmaker(engine, expire_on_commit=False)
    engine.dispose()


@pytest.fixture
def context(sessions):
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
        with sessions.begin() as db:
            db.query(Kind).filter(Kind.user_id == value.user_id).delete()
            db.query(User).filter(User.id == value.user_id).delete()


def establish_snapshot(db: Session, context: Context) -> None:
    # Authentication and package reads may already have opened a consistent read.
    assert db.query(User.id).filter(User.id == context.user_id).scalar() is not None


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


def test_simultaneous_enrollment_creates_only_one_account(context):
    def enroll(db):
        return context.accounts.enroll(
            db, user_id=context.user_id, request=context.credential()
        )

    assert race(context, enroll, enroll) == ["ok", "plugin_auth_revision_conflict"]
    with context.sessions() as db:
        assert len(context.accounts.list_connections(db, user_id=context.user_id)) == 1


def test_simultaneous_device_registration_keeps_one_runtime_identity(context):
    def register(db):
        return device_service.upsert_device_crd(
            db,
            user_id=context.user_id,
            device_id="concurrent-registration",
            name="Synthetic device",
            runtime_instance_id="same-runtime-instance",
        )

    assert race(context, register, register) == ["ok", "ok"]
    with context.sessions() as db:
        assert (
            db.query(Kind)
            .filter_by(
                user_id=context.user_id,
                namespace="default",
                kind="Device",
                name="concurrent-registration",
            )
            .count()
            == 1
        )


def test_simultaneous_transfers_reserve_an_account_only_once(context):
    first, second = context.ticket(), context.ticket()
    assert race(
        context,
        lambda db: context.stage(db, first),
        lambda db: context.stage(db, second),
    ) == ["ok", "plugin_auth_transfer_pending"]
    with context.sessions() as db:
        assert (
            db.query(Kind)
            .filter(
                Kind.user_id == context.user_id,
                Kind.kind == "ConnectorTransfer",
                Kind.is_active.is_(True),
            )
            .count()
            == 1
        )


def test_old_snapshot_cannot_enroll_over_a_new_transfer(context):
    ticket = context.ticket()
    with context.sessions() as stale:
        establish_snapshot(stale, context)
        with context.sessions.begin() as current:
            context.stage(current, ticket)
        with pytest.raises(
            PluginAccountAuthError, match="plugin_auth_transfer_pending"
        ):
            context.accounts.enroll(
                stale, user_id=context.user_id, request=context.credential()
            )


@pytest.mark.parametrize(
    "winner,late,error",
    [
        ("abort", "finish", "plugin_auth_source_changed"),
        ("finish", "abort", "plugin_auth_transfer_completed"),
    ],
)
def test_old_snapshot_cannot_reverse_a_finalized_transfer(context, winner, late, error):
    ticket = context.ticket()
    with context.sessions.begin() as db:
        context.stage(db, ticket)
    with context.sessions() as stale:
        establish_snapshot(stale, context)
        with context.sessions.begin() as current:
            context.transfer_action(current, ticket, winner)
        with pytest.raises(PluginAccountAuthError, match=error):
            context.transfer_action(stale, ticket, late)


def test_old_snapshot_reuses_the_completed_transfer_receipt(context):
    ticket = context.ticket()
    with context.sessions.begin() as db:
        context.stage(db, ticket)
    with context.sessions() as stale:
        establish_snapshot(stale, context)
        with context.sessions.begin() as current:
            completed = context.transfer_action(current, ticket, "finish")
        assert context.transfer_action(stale, ticket, "finish") == completed


def test_owner_lock_refreshes_a_previously_loaded_user(context):
    with context.sessions() as stale:
        cached_user = stale.get(User, context.user_id)
        assert cached_user.is_active
        with context.sessions.begin() as current:
            current.query(User).filter(User.id == context.user_id).update(
                {User.is_active: False}
            )
        with pytest.raises(
            PluginAccountAuthError, match="plugin_auth_owner_unavailable"
        ):
            context.accounts.enroll(
                stale, user_id=context.user_id, request=context.credential()
            )


@pytest.fixture
def oauth(context):
    with context.sessions.begin() as db:
        request = context.credential().model_copy(
            update={
                "credential": SecretStr(
                    '{"access_token":"synthetic-old","refresh_token":"synthetic-refresh","expires_at":1}'
                )
            }
        )
        account = context.accounts.enroll(db, user_id=context.user_id, request=request)
        account = context.accounts.grant_device(
            db,
            user_id=context.user_id,
            connection_id=account.id,
            device_id=context.device_id,
            expected_revision=account.revision,
        )
    execution = PluginAuthExecutionService(context.accounts)
    return (
        PluginOAuthOperations(execution),
        PluginNativeExecution(
            installed_plugin_id=context.plugin_id, connector_slug="test"
        ),
        account,
    )


def test_concurrent_refresh_claims_have_one_owner(context, oauth):
    operations, request, _ = oauth

    def claim(db):
        result = operations.begin(
            db, user_id=context.user_id, device_id=context.device_id, request=request
        )
        assert result["state"] == "claimed"

    assert race(context, claim, claim) == ["ok", "plugin_auth_revision_conflict"]


def test_stale_refresh_completion_cannot_restore_a_disconnected_account(context, oauth):
    operations, request, _ = oauth
    with context.sessions.begin() as db:
        lease = operations.begin(
            db, user_id=context.user_id, device_id=context.device_id, request=request
        )
    with context.sessions() as stale:
        establish_snapshot(stale, context)
        with context.sessions.begin() as current:
            account = context.accounts.list_connections(
                current, user_id=context.user_id
            )[0]
            context.accounts.disconnect(
                current,
                user_id=context.user_id,
                connection_id=account.id,
                expected_revision=account.revision,
            )
        operations.finish(
            stale,
            user_id=context.user_id,
            device_id=context.device_id,
            request=PluginOAuthFinish(
                connection_id=lease["connection_id"],
                operation_id=lease["operation_id"],
                succeeded=True,
                account_id="synthetic-account",
                credential=SecretStr(
                    json.dumps(
                        {
                            "access_token": "synthetic-new",
                            "refresh_token": "synthetic-rotated",
                            "expires_at": time.time() + 3600,
                        }
                    )
                ),
            ),
        )
        stale.commit()
    with context.sessions() as db:
        account = context.accounts.list_connections(db, user_id=context.user_id)[0]
        assert account.status == "disconnected"
        assert account.device_ids == []
        assert account.provider_revocation == "pending"
        with pytest.raises(
            PluginAccountAuthError, match="plugin_auth_device_not_granted"
        ):
            operations.execution.prepare(
                db,
                user_id=context.user_id,
                device_id=context.device_id,
                request=request,
            )


@pytest.mark.parametrize("action", ["disable", "revoke"])
def test_stale_automatic_reconciler_preserves_user_opt_out(context, action):
    from app.services.plugin_auth_automation import PluginAuthAutomationService

    automation = PluginAuthAutomationService(context.accounts)
    with context.sessions.begin() as db:
        device = (
            db.query(Kind)
            .filter(
                Kind.user_id == context.user_id,
                Kind.kind == "Device",
                Kind.namespace == "default",
                Kind.name == context.device_id,
            )
            .one()
        )
        device.json = {"spec": {**device.json["spec"], "deviceType": "cloud"}}
        account = context.accounts.enroll(
            db, user_id=context.user_id, request=context.credential()
        )
        if action == "revoke":
            automation.grant_current_device(
                db, user_id=context.user_id, device_id=context.device_id
            )
    with context.sessions() as stale:
        establish_snapshot(stale, context)
        context.accounts.list_connections(stale, user_id=context.user_id)
        with context.sessions.begin() as current:
            if action == "disable":
                automation.configure(current, context.user_id, False)
            else:
                account = context.accounts.list_connections(
                    current, user_id=context.user_id
                )[0]
                context.accounts.revoke_device(
                    current,
                    user_id=context.user_id,
                    connection_id=account.id,
                    device_id=context.device_id,
                    expected_revision=account.revision,
                )
        automation.reconcile(
            stale,
            user_id=context.user_id,
            device_id=context.device_id,
            installed_ids=[context.plugin_id],
        )
        stale.commit()
    with context.sessions() as db:
        assert (
            context.accounts.list_connections(db, user_id=context.user_id)[0].device_ids
            == []
        )
