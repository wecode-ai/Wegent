"""Real Redis/InnoDB transaction races against disposable local services."""

import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack
from datetime import timedelta

import pytest
from pydantic import SecretStr
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session, sessionmaker

from app.models.kind import Kind
from app.models.user import User
from app.schemas.plugin_account_auth import (
    PluginNativeEnrollment,
    PluginNativeExecution,
    PluginNativeLocalLifecycle,
    PluginOAuthFinish,
)
from app.services import plugin_policy_revision as policy_revision
from app.services import plugin_write_coordination as coordination
from app.services import plugin_write_resources as resources
from app.services.device_service import device_service
from app.services.installed_plugin_service import InstalledPluginService
from app.services.plugin_account_connections import (
    PluginAccountAuthError,
)
from app.services.plugin_auth_execution import PluginAuthExecutionService
from app.services.plugin_auth_local_lifecycle import PluginAuthLocalLifecycleService
from app.services.plugin_oauth_operations import PluginOAuthOperations
from app.services.plugin_write_coordination import (
    PluginWriteError,
    acquire_plugin_write_lock,
)
from integration_checks.plugin_auth_fixtures import (
    CREDENTIAL,
    Context,
    context,
    establish_snapshot,
    race,
    sessions,
)


def test_simultaneous_enrollment_creates_only_one_account(context):
    def enroll(db):
        return context.accounts.enroll(
            db, user_id=context.user_id, request=context.credential()
        )

    assert race(context, enroll, enroll) == ["ok", "plugin_auth_revision_conflict"]
    with context.sessions() as db:
        assert len(context.accounts.list_connections(db, user_id=context.user_id)) == 1


def test_simultaneous_first_policy_materialization_keeps_one_business_parent(
    context, monkeypatch
):
    first_locked, release_first = threading.Event(), threading.Event()
    second_waiting, second_locked = threading.Event(), threading.Event()
    thread_state = threading.local()
    client = coordination._redis_client()
    real_lock = client.lock

    def observed_lock(*args, **kwargs):
        lock = real_lock(*args, **kwargs)
        acquire = lock.acquire

        def observed_acquire(*acquire_args, **acquire_kwargs):
            if getattr(thread_state, "second", False):
                second_waiting.set()
            return acquire(*acquire_args, **acquire_kwargs)

        lock.acquire = observed_acquire
        return lock

    monkeypatch.setattr(client, "lock", observed_lock)

    def read_first_parent(second=False):
        thread_state.second = second
        with context.sessions.begin() as db:
            establish_snapshot(db, context)
            acquire_plugin_write_lock(db, context.user_id)
            parent = policy_revision.read_policy_revision(db, context.user_id)
            if second:
                second_locked.set()
            else:
                first_locked.set()
                assert release_first.wait(5)
            return parent.row_id, parent.revision

    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(read_first_parent)
        try:
            assert first_locked.wait(5)
            second = pool.submit(read_first_parent, True)
            assert second_waiting.wait(5)
            assert not second_locked.wait(0.1)
        finally:
            release_first.set()
        parents = [request.result(timeout=10) for request in (first, second)]

    assert parents[0][0] == parents[1][0]
    assert [parent[1] for parent in parents] == [0, 1]
    with context.sessions() as db:
        rows = (
            db.query(Kind)
            .filter_by(
                user_id=context.user_id,
                kind="ConnectorAuthPolicy",
                namespace="plugin-auth",
                name="account",
            )
            .all()
        )
        assert len(rows) == 1 and rows[0].id == parents[0][0]
        assert rows[0].is_active is True
        assert rows[0].json == {"spec": {"enabled": True, "revision": 2}}


def test_inactive_policy_row_is_reactivated_with_its_stored_preference(context):
    with context.sessions.begin() as db:
        policy_revision.read_policy_revision(db, context.user_id)
    with context.sessions.begin() as db:
        db.query(Kind).filter_by(
            user_id=context.user_id,
            kind="ConnectorAuthPolicy",
            namespace="plugin-auth",
            name="account",
        ).update(
            {
                "is_active": False,
                "json": {"spec": {"enabled": False, "revision": 2}},
            }
        )

    with context.sessions.begin() as db:
        parent = policy_revision.read_policy_revision(db, context.user_id)

    assert parent.revision == 2
    with context.sessions() as db:
        row = (
            db.query(Kind)
            .filter_by(
                user_id=context.user_id,
                kind="ConnectorAuthPolicy",
                namespace="plugin-auth",
                name="account",
            )
            .one()
        )
        assert row.is_active is True
        assert row.json == {"spec": {"enabled": False, "revision": 2}}


def test_local_logout_commits_while_an_unrelated_transaction_holds_the_user_row(
    context,
):
    with context.sessions.begin() as db:
        account = context.accounts.enroll(
            db, user_id=context.user_id, request=context.credential()
        )
        context.accounts.grant_device(
            db,
            user_id=context.user_id,
            connection_id=account.id,
            device_id=context.device_id,
            expected_revision=account.revision,
        )

    def logout():
        with context.sessions.kw["bind"].connect() as connection:
            original = connection.scalar(
                text("SELECT @@SESSION.innodb_lock_wait_timeout")
            )
            connection.commit()
            try:
                connection.execute(text("SET SESSION innodb_lock_wait_timeout = 1"))
                connection.commit()
                with context.sessions(bind=connection) as db:
                    result = PluginAuthLocalLifecycleService(context.accounts).exchange(
                        db,
                        user_id=context.user_id,
                        device_id=context.device_id,
                        request=PluginNativeLocalLifecycle(
                            installed_plugin_id=context.plugin_id,
                            connector_slug="test",
                            action="logout",
                        ),
                    )
                    db.commit()
                    return result
            finally:
                connection.rollback()
                connection.execute(
                    text("SET SESSION innodb_lock_wait_timeout = :timeout"),
                    {"timeout": original},
                )
                connection.commit()
                assert (
                    connection.scalar(text("SELECT @@SESSION.innodb_lock_wait_timeout"))
                    == original
                )
                connection.commit()

    with context.sessions() as blocker:
        blocker.execute(
            text("SELECT id FROM users WHERE id = :user_id FOR UPDATE"),
            {"user_id": context.user_id},
        ).one()
        with ThreadPoolExecutor(max_workers=1) as pool:
            assert pool.submit(logout).result(timeout=3) == {"status": "ok"}
        assert blocker.in_transaction()

    with context.sessions() as db:
        account = context.accounts.list_connections(db, user_id=context.user_id)[0]
        assert account.status == "disconnected"
        assert account.device_ids == []


@pytest.fixture
def single_connection_sessions(context):
    engine = create_engine(
        context.sessions.kw["bind"].url,
        isolation_level="REPEATABLE READ",
        pool_size=1,
        max_overflow=0,
        pool_timeout=1,
    )
    policy_pool = resources.policy_engine(engine)
    try:
        yield sessionmaker(
            engine,
            class_=context.sessions.class_,
            expire_on_commit=False,
        ), policy_pool
    finally:
        policy_pool.dispose()
        engine.dispose()


def test_first_policy_creation_does_not_need_a_second_business_pool_connection(
    context, single_connection_sessions
):
    sessions, _ = single_connection_sessions
    with sessions() as db:
        establish_snapshot(db, context)

        connection = context.accounts.enroll(
            db, user_id=context.user_id, request=context.credential()
        )
        db.commit()

    with context.sessions() as db:
        stored = context.accounts.list_connections(db, user_id=context.user_id)
        assert stored[0].id == connection.id


def test_saturated_initial_policy_pool_returns_retryable_error_and_releases_redis(
    context, single_connection_sessions
):
    sessions, policy_pool = single_connection_sessions
    with ExitStack() as connections:
        for _ in range(4):
            connections.enter_context(policy_pool.connect())
        with sessions() as db:
            establish_snapshot(db, context)

            with pytest.raises(PluginWriteError) as failure:
                context.accounts.enroll(
                    db, user_id=context.user_id, request=context.credential()
                )

            assert failure.value.code == "plugin_write_unavailable"
            assert failure.value.status_code == 503
            assert not coordination._redis_client().exists(
                f"wegent:plugin-write:{context.user_id}"
            )


def test_existing_policy_uses_no_connection_from_the_initial_policy_pool(
    context, single_connection_sessions
):
    sessions, policy_pool = single_connection_sessions
    with sessions.begin() as db:
        acquire_plugin_write_lock(db, context.user_id)

    with ExitStack() as connections:
        for _ in range(4):
            connections.enter_context(policy_pool.connect())
        with sessions.begin() as db:
            establish_snapshot(db, context)
            enrolled = context.accounts.enroll(
                db, user_id=context.user_id, request=context.credential()
            )

    with context.sessions() as db:
        assert context.accounts.list_connections(db, user_id=context.user_id) == [
            enrolled
        ]


def test_uninstall_invalidates_plugin_loaded_before_coordination(context):
    with context.sessions() as stale:
        cached = stale.get(Kind, context.plugin_id)
        assert cached.is_active
        with context.sessions() as current:
            InstalledPluginService().uninstall_installed_plugin(
                db=current,
                user_id=context.user_id,
                installed_id=context.plugin_id,
            )

        with pytest.raises(
            PluginAccountAuthError, match="plugin_auth_plugin_not_found"
        ):
            context.accounts.enroll(
                stale, user_id=context.user_id, request=context.credential()
            )

    with context.sessions() as db:
        assert context.accounts.list_connections(db, user_id=context.user_id) == []


def test_expired_worker_cannot_commit_after_successor_advances_parent_revision(context):
    with context.sessions() as stale:
        acquire_plugin_write_lock(stale, context.user_id)
        stale.add(
            Kind(
                user_id=context.user_id,
                kind="ConnectorLocalAuthPolicy",
                namespace="plugin-auth",
                name="revision-test",
                json={"spec": {"writer": "expired"}},
            )
        )
        stale.flush()
        lease = stale.info["plugin_write_leases"][context.user_id]
        observed_revision = lease.policy.revision
        # Model a pause immediately after a successful Redis ownership check.
        lease.check = lambda: None
        coordination._redis_client().delete(f"wegent:plugin-write:{context.user_id}")
        with context.sessions.begin() as successor:
            acquire_plugin_write_lock(successor, context.user_id)
            successor.add(
                Kind(
                    user_id=context.user_id,
                    kind="ConnectorLocalAuthPolicy",
                    namespace="plugin-auth",
                    name="revision-test",
                    json={"spec": {"writer": "successor"}},
                )
            )

        with pytest.raises(PluginWriteError, match="plugin_write_conflict"):
            stale.commit()
        stale.rollback()

    with context.sessions() as db:
        rows = (
            db.query(Kind)
            .filter_by(
                user_id=context.user_id,
                kind="ConnectorLocalAuthPolicy",
                namespace="plugin-auth",
                name="revision-test",
            )
            .all()
        )
        assert [row.json["spec"]["writer"] for row in rows] == ["successor"]
        parent = (
            db.query(Kind)
            .filter_by(
                user_id=context.user_id,
                kind="ConnectorAuthPolicy",
                namespace="plugin-auth",
                name="account",
            )
            .one()
        )
        assert parent.json["spec"]["revision"] == observed_revision + 1


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


def test_coordination_refreshes_a_previously_loaded_user(context):
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

    assert race(context, claim, claim) == ["ok", "plugin_auth_refresh_in_progress"]


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


def automatic(context: Context, db: Session) -> dict:
    from app.services.plugin_auth_automation import PluginAuthAutomationService

    return PluginAuthAutomationService(context.accounts).reconcile(
        db,
        user_id=context.user_id,
        device_id=context.device_id,
        installed_ids=[context.plugin_id],
    )["migrations"][0]


def automatic_rows(context: Context, db: Session):
    return db.query(Kind).filter(
        Kind.user_id == context.user_id,
        Kind.kind == "ConnectorMigration",
        Kind.namespace == "plugin-auth",
        Kind.json["spec"]["automatic"].as_boolean().is_(True),
    )


def test_concurrent_automatic_sync_reuses_one_slot_through_exclusive_transfer(context):
    ids = []

    def reconcile(db):
        ids.append(automatic(context, db)["id"])

    assert race(context, reconcile, reconcile) == ["ok", "ok"]
    assert len(set(ids)) == 1
    intent = ids[0]
    with context.sessions.begin() as db:
        row_id = automatic_rows(context, db).one().id
        ticket = PluginNativeEnrollment(
            migration_id=intent,
            account_id="synthetic-account",
            credential=CREDENTIAL,
        )
        context.stage(db, ticket)
    ids.clear()
    assert race(context, reconcile, reconcile) == ["ok", "ok"]
    assert ids == [intent, intent]
    with context.sessions.begin() as db:
        context.transfer_action(db, ticket, "finish")
    ids.clear()

    assert race(context, reconcile, reconcile) == ["ok", "ok"]

    assert len(set(ids)) == 1 and ids[0] != intent
    with context.sessions.begin() as db:
        row = automatic_rows(context, db).one()
        assert row.id == row_id and row.name == ids[0]
        # Slot rotation cannot invalidate a detached transfer's durable receipt.
        assert context.transfer_action(db, ticket, "prepare") == {"state": "completed"}


def test_stale_snapshot_reuses_rotated_automatic_slot_without_inserting(context):
    with context.sessions.begin() as db:
        row = db.get(Kind, context.plugin_id)
        spec = json.loads(json.dumps(row.json["spec"]))
        spec["components"]["connectors"][0]["accountAuth"].pop("exportMode")
        row.json = {"spec": spec}
        intent = automatic(context, db)["id"]
        row_id = automatic_rows(context, db).one().id
    with context.sessions() as stale:
        establish_snapshot(stale, context)
        cached = automatic_rows(context, stale).one()
        assert cached.name == intent and cached.is_active
        with context.sessions.begin() as current:
            context.transfers.migrations.consume(
                current,
                user_id=context.user_id,
                device_id=context.device_id,
                request=PluginNativeEnrollment(
                    migration_id=intent,
                    account_id="synthetic-account",
                    credential=CREDENTIAL,
                ),
            )
            renewed = automatic(context, current)["id"]

        assert automatic(context, stale)["id"] == renewed
        stale.commit()

    with context.sessions() as db:
        row = automatic_rows(context, db).one()
        assert row.id == row_id and row.name == renewed and renewed != intent


def test_automatic_history_compaction_works_with_mysql_json_and_window_ranking(context):
    from scripts.compact_plugin_auth_migrations import compact_batch, obsolete_query

    with context.sessions.begin() as db:
        automatic(context, db)
        latest = automatic_rows(context, db).one()
        latest_id = latest.id
        for offset in (1, 2):
            db.add(
                Kind(
                    user_id=context.user_id,
                    kind="ConnectorMigration",
                    namespace="plugin-auth",
                    name=f"{offset:064x}",
                    json=json.loads(json.dumps(latest.json)),
                    is_active=False,
                    updated_at=latest.updated_at - timedelta(seconds=offset),
                )
            )
    with context.sessions() as db:
        assert obsolete_query(db, context.user_id, int(time.time())).count() == 2
    with context.sessions.begin() as db:
        assert compact_batch(db, context.user_id, 1) == 1
    with context.sessions.begin() as db:
        assert compact_batch(db, context.user_id, 1) == 1
    with context.sessions.begin() as db:
        assert compact_batch(db, context.user_id, 1) == 0
        assert automatic_rows(context, db).one().id == latest_id
