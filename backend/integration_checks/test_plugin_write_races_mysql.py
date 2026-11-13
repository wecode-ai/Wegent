"""Real Redis contention, worker loss, and plugin lifecycle interleavings."""

import io
import json
import multiprocessing
import os
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from typing import Callable
from zipfile import ZipFile

import pytest
from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.plugin_marketplace import Plugin
from app.models.skill_binary import SkillBinary
from app.schemas.plugin_account_auth import (
    PluginCredentialWrite,
    PluginNativeEnrollment,
    PluginNativeLocalLifecycle,
)
from app.services import plugin_write_coordination as coordination
from app.services.installed_plugin_service import InstalledPluginService
from app.services.plugin_account_connections import (
    PluginAccountAuthError,
    PluginAccountConnectionService,
)
from app.services.plugin_auth_automation import PluginAuthAutomationService
from app.services.plugin_auth_local_lifecycle import PluginAuthLocalLifecycleService
from app.services.plugin_catalog_identity import ensure_catalog_plugin
from app.services.plugin_credential_cipher import PluginCredentialCipher
from app.services.plugin_kind_revision import replace_installed_kind
from app.services.plugin_write_coordination import (
    PluginWriteError,
    acquire_plugin_write_lock,
    configure_plugin_session,
)
from integration_checks.plugin_auth_fixtures import (
    CREDENTIAL,
    Context,
    context,
    context_factory,
    establish_snapshot,
    race,
    sessions,
)


@pytest.mark.parametrize("same_slug", [False, True])
def test_catalog_first_publish_does_not_lock_missing_identity_gaps(sessions, same_slug):
    """Distinct first publishes must coexist; identical identities serialize."""
    engine = sessions.kw["bind"].execution_options(isolation_level="REPEATABLE READ")
    Plugin.__table__.create(engine, checkfirst=True)
    prefix = f"catalog-race-{uuid.uuid4().hex}"
    slugs = [f"{prefix}-a", f"{prefix}-a" if same_slug else f"{prefix}-b"]
    start = threading.Barrier(2)
    probed = threading.Barrier(2)
    locked = threading.Barrier(2)

    def synchronize_identity_reads(
        _connection, _cursor, statement, _parameters, _context, _many
    ):
        if statement.startswith("SELECT plugins.id ") and "FOR UPDATE" not in statement:
            # Both RR snapshots miss the identities, including the loser of a
            # same-slug race that must later read the committed winner's row.
            probed.wait(timeout=5)
        if (
            not same_slug
            and statement.startswith("SELECT plugins.")
            and "FOR UPDATE" in statement
        ):
            # Both transactions have selected their identity before committing.
            # A missing-row lock here used to make their subsequent inserts deadlock.
            locked.wait(timeout=5)

    def publish_identity(slug):
        start.wait(timeout=5)
        # The CLI uses ordinary sessions; plugin request sessions switch to READ COMMITTED.
        with Session(engine) as db, db.begin():
            assert db.connection().get_isolation_level() == "REPEATABLE READ"
            return ensure_catalog_plugin(
                db, {"catalog_namespace": "enterprise", "slug": slug}
            ).id

    event.listen(engine, "after_cursor_execute", synchronize_identity_reads)
    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            pending = [pool.submit(publish_identity, slug) for slug in slugs]
            ids = [future.result(timeout=10) for future in pending]
        assert (ids[0] == ids[1]) is same_slug
        with sessions() as db:
            assert db.query(Plugin).filter(Plugin.slug.in_(slugs)).count() == (
                1 if same_slug else 2
            )
    finally:
        event.remove(engine, "after_cursor_execute", synchronize_identity_reads)
        with sessions.begin() as db:
            db.query(Plugin).filter(Plugin.slug.in_(slugs)).delete(
                synchronize_session=False
            )


def test_catalog_republish_does_not_block_first_publish_in_preceding_gap(sessions):
    """A slow existing publisher must not block a different identity's insert."""
    engine = sessions.kw["bind"].execution_options(isolation_level="REPEATABLE READ")
    Plugin.__table__.create(engine, checkfirst=True)
    prefix = f"catalog-gap-{uuid.uuid4().hex}"
    lower_slug, new_slug, existing_slug = (f"{prefix}-{suffix}" for suffix in "abc")
    with Session(engine) as db, db.begin():
        existing = Plugin(catalog_namespace="enterprise", slug=existing_slug)
        db.add_all([Plugin(catalog_namespace="enterprise", slug=lower_slug), existing])
        db.flush()
        existing_id = existing.id

    def publish_new_identity():
        with Session(engine) as db, db.begin():
            assert db.connection().get_isolation_level() == "REPEATABLE READ"
            return ensure_catalog_plugin(
                db, {"catalog_namespace": "enterprise", "slug": new_slug}
            ).id

    try:
        with Session(engine) as holder, ThreadPoolExecutor(max_workers=1) as pool:
            assert holder.connection().get_isolation_level() == "REPEATABLE READ"
            actual = ensure_catalog_plugin(
                holder, {"catalog_namespace": "enterprise", "slug": existing_slug}
            )
            assert actual.id == existing_id
            try:
                # Keep the existing identity locked as it is during package upload.
                # The neighboring first publish must commit before that lock releases.
                created_id = pool.submit(publish_new_identity).result(timeout=5)
                assert created_id != existing_id
            finally:
                holder.rollback()
        with sessions() as db:
            assert (
                db.query(Plugin)
                .filter_by(catalog_namespace="enterprise", slug=new_slug)
                .one()
                .id
                == created_id
            )
    finally:
        with sessions.begin() as db:
            db.query(Plugin).filter(
                Plugin.catalog_namespace == "enterprise",
                Plugin.slug.in_([lower_slug, new_slug, existing_slug]),
            ).delete(synchronize_session=False)


def lock_key(context: Context, name: str = "mysql-auth-fixture") -> str:
    return f"wegent:plugin-write:{context.user_id}:{name}"


def lifecycle(context: Context, db: Session, action: str) -> dict:
    return PluginAuthLocalLifecycleService(context.accounts).exchange(
        db,
        user_id=context.user_id,
        device_id=context.device_id,
        request=PluginNativeLocalLifecycle(
            installed_plugin_id=context.plugin_id, connector_slug="test", action=action
        ),
    )


def run_ordered(
    context: Context,
    first: Callable[[Session], object],
    waiting: Callable[[Session], object],
) -> tuple[object, object]:
    """Keep a real Redis lease while a second writer waits, then release it."""
    attempted, acquired = threading.Event(), threading.Event()

    def worker():
        with context.sessions() as db:
            establish_snapshot(db, context)
            attempted.set()
            acquire_plugin_write_lock(
                db, context.user_id, installed_id=context.plugin_id
            )
            acquired.set()
            try:
                result = waiting(db)
                db.commit()
                return result
            except PluginAccountAuthError as error:
                db.rollback()
                return error.code

    with context.sessions() as holder, ThreadPoolExecutor(max_workers=1) as pool:
        acquire_plugin_write_lock(
            holder, context.user_id, installed_id=context.plugin_id
        )
        with coordination._redis_client().monitor() as monitor:
            pending = pool.submit(worker)
            try:
                assert attempted.wait(3)
                deadline = time.monotonic() + 3
                while time.monotonic() < deadline:
                    command = monitor.next_command()["command"]
                    if command.startswith(f"SET {lock_key(context)} "):
                        break
                else:
                    pytest.fail("The waiting writer did not send its Redis acquire")
                assert not acquired.is_set()
                result = first(holder)
                holder.commit()
            finally:
                holder.rollback()
        return result, pending.result(timeout=5)


@pytest.fixture
def local_context(context):
    with context.sessions.begin() as db:
        plugin = db.get(Kind, context.plugin_id)
        payload = deepcopy(plugin.json)
        connector = payload["spec"]["components"]["connectors"][0]
        connector["accountAuth"].pop("exportMode")
        connector["localAuth"] = {
            "kind": "browser_oauth",
            "health": ["scripts/auth.py", "health"],
            "start": ["scripts/auth.py", "login"],
        }
        plugin.json = payload
    return context


def login_ticket(context: Context):
    with context.sessions.begin() as db:
        lifecycle(context, db, "login")
        row = (
            db.query(Kind)
            .filter_by(
                user_id=context.user_id,
                kind="ConnectorMigration",
                namespace="plugin-auth",
                is_active=True,
            )
            .one()
        )
        return PluginNativeEnrollment(
            migration_id=row.name,
            account_id="synthetic-account",
            credential=CREDENTIAL,
        )


def consume(context: Context, db: Session, ticket):
    return context.transfers.migrations.consume(
        db, user_id=context.user_id, device_id=context.device_id, request=ticket
    )


def uninstall(context: Context, db: Session) -> None:
    InstalledPluginService().uninstall_installed_plugin(
        db=db, user_id=context.user_id, installed_id=context.plugin_id
    )


def test_same_user_contention_is_retryable_after_the_holder_rolls_back(context):
    automation = PluginAuthAutomationService(context.accounts)
    client = coordination._redis_client()
    with context.sessions() as holder:
        automation.configure(holder, context.user_id, False)
        token = client.get(lock_key(context, "@account-policy"))
        with context.sessions() as blocked:
            with pytest.raises(PluginWriteError) as failure:
                automation.configure(blocked, context.user_id, True)
            assert failure.value.code == "plugin_write_busy"
            assert failure.value.status_code == 503
            assert client.get(lock_key(context, "@account-policy")) == token
            blocked.rollback()
        holder.rollback()

    assert not client.exists(lock_key(context, "@account-policy"))
    with context.sessions.begin() as retry:
        assert automation.configure(retry, context.user_id, True) == {"enabled": True}
    with context.sessions() as db:
        policies = automation._policy(db, context.user_id).all()
        assert len(policies) == 1 and policies[0].json["spec"]["enabled"] is True
    assert not client.exists(lock_key(context, "@account-policy"))


def test_another_user_enrolls_while_the_same_account_identity_is_uncommitted(
    context, context_factory
):
    with context_factory() as other, context.sessions() as holder:
        first = context.accounts.enroll(
            holder, user_id=context.user_id, request=context.credential()
        )

        def enroll_other():
            with other.sessions.begin() as db:
                return other.accounts.enroll(
                    db, user_id=other.user_id, request=other.credential()
                )

        with ThreadPoolExecutor(max_workers=1) as pool:
            second = pool.submit(enroll_other).result(timeout=2)
        assert first.id == second.id
        assert coordination._redis_client().exists(lock_key(context))
        assert not coordination._redis_client().exists(lock_key(other))
        holder.rollback()
        with context.sessions() as db:
            assert context.accounts.list_connections(db, user_id=context.user_id) == []
            assert other.accounts.list_connections(db, user_id=other.user_id) == [
                second
            ]


def test_real_redis_ttl_expiry_rejects_the_old_transaction_and_allows_recovery(context):
    client = coordination._redis_client()
    with context.sessions() as expired:
        context.accounts.enroll(
            expired, user_id=context.user_id, request=context.credential()
        )
        assert client.pexpire(lock_key(context), 100)
        with context.sessions.begin() as successor:
            recovered = context.accounts.enroll(
                successor, user_id=context.user_id, request=context.credential()
            )
        with pytest.raises(PluginWriteError, match="plugin_write_lease_lost"):
            expired.commit()
        expired.rollback()
    with context.sessions() as db:
        assert context.accounts.list_connections(db, user_id=context.user_id) == [
            recovered
        ]
    assert not client.exists(lock_key(context))


def test_combined_parent_cas_fences_a_successor_while_commit_outlives_redis(context):
    """An existing row remains protected after the last lease check, during COMMIT."""
    from app.services.device.plugin_sync_protocol import lock_plugin_sync_state

    with context.sessions.begin() as db:
        lock_plugin_sync_state(db, context.user_id)
    committing, finish_commit, successor_read = (
        threading.Event(),
        threading.Event(),
        threading.Event(),
    )

    def paused_commit():
        with context.sessions() as db:
            acquire_plugin_write_lock(
                db, context.user_id, installed_id=context.plugin_id
            )
            parent = db.get(Kind, context.plugin_id)
            payload = deepcopy(parent.json)
            payload["spec"]["enabled"] = False
            replace_installed_kind(db, parent, payload)
            connection = db.connection()

            def pause(_connection):
                committing.set()
                assert finish_commit.wait(5), "COMMIT was not released"

            event.listen(connection, "commit", pause)
            try:
                db.commit()
            finally:
                event.remove(connection, "commit", pause)

    def write_successor():
        with context.sessions() as db:
            acquire_plugin_write_lock(
                db, context.user_id, installed_id=context.plugin_id
            )
            parent = db.get(Kind, context.plugin_id)
            assert parent.json["spec"].get("writeRevision", 0) == 0
            payload = deepcopy(parent.json)
            payload["spec"]["enabled"] = True
            successor_read.set()
            replace_installed_kind(db, parent, payload)
            db.commit()

    client = coordination._redis_client()
    with ThreadPoolExecutor(max_workers=2) as pool:
        old = pool.submit(paused_commit)
        try:
            assert committing.wait(5), "Writer did not reach the real COMMIT boundary"
            assert client.pexpire(lock_key(context), 100)
            successor = pool.submit(write_successor)
            assert successor_read.wait(
                5
            ), "Successor did not read the old committed row"
        finally:
            finish_commit.set()
        old.result(timeout=5)
        with pytest.raises(PluginWriteError, match="plugin_write_conflict"):
            successor.result(timeout=5)

    with context.sessions() as db:
        parent = db.get(Kind, context.plugin_id)
        assert parent.json["spec"]["enabled"] is False
        assert parent.json["spec"]["writeRevision"] == 1
    assert not client.exists(lock_key(context))


def abandoned_worker(mysql_url, user_id, plugin_id, ready) -> None:
    """A killed process must leave its Redis lease to expire naturally."""
    engine = create_engine(mysql_url)
    accounts = PluginAccountConnectionService(
        PluginCredentialCipher("test", {"test": b"a" * 32})
    )
    with Session(engine) as db:
        configure_plugin_session(db)
        accounts.enroll(
            db,
            user_id=user_id,
            request=PluginCredentialWrite(
                installed_plugin_id=plugin_id,
                connector_slug="test",
                account_id="synthetic-account",
                credential=CREDENTIAL,
                expected_revision=0,
            ),
        )
        ready.send("acquired")
        threading.Event().wait(30)


def test_killed_worker_rolls_back_mysql_and_recovers_after_its_redis_ttl(
    context, monkeypatch
):
    # Reuse the exact test URL so a * auth-protected Redis still works.
    monkeypatch.setenv("REDIS_URL", os.environ["PLUGIN_AUTH_REDIS_TEST_URL"])
    client = coordination._redis_client()
    worker_context = multiprocessing.get_context("spawn")
    parent, child = worker_context.Pipe(duplex=False)
    process = worker_context.Process(
        target=abandoned_worker,
        args=(
            context.sessions.kw["bind"].url.render_as_string(hide_password=False),
            context.user_id,
            context.plugin_id,
            child,
        ),
    )
    process.start()
    child.close()
    try:
        assert parent.poll(30), "The child did not acquire its real lease"
        assert parent.recv() == "acquired"
        process.kill()
        process.join(timeout=3)
        assert not process.is_alive() and process.exitcode != 0
        assert client.pexpire(lock_key(context), 100)
        with context.sessions.begin() as db:
            recovered = context.accounts.enroll(
                db, user_id=context.user_id, request=context.credential()
            )
        with context.sessions() as db:
            assert context.accounts.list_connections(db, user_id=context.user_id) == [
                recovered
            ]
    finally:
        if process.is_alive():
            process.kill()
            process.join(timeout=3)
        client.delete(lock_key(context))
        parent.close()


@pytest.mark.parametrize("first", ["logout", "consume"])
def test_logout_and_inflight_local_enrollment_cannot_restore_access(
    local_context, first
):
    context = local_context
    ticket = login_ticket(context)
    logout = lambda db: lifecycle(context, db, "logout")
    enrollment = lambda db: consume(context, db, ticket)
    winner, waiting = run_ordered(
        context,
        logout if first == "logout" else enrollment,
        enrollment if first == "logout" else logout,
    )
    if first == "logout":
        assert winner == {"status": "ok"}
        assert waiting == "plugin_auth_migration_expired"
    else:
        assert winner.status == "connected" and waiting == {"status": "ok"}
    with context.sessions.begin() as db:
        assert lifecycle(context, db, "status") == {"status": "need_login"}
        assert PluginAuthAutomationService(context.accounts).reconcile(
            db,
            user_id=context.user_id,
            device_id=context.device_id,
            installed_ids=[context.plugin_id],
        ) == {"migrations": []}
        for row in context.accounts._query(db, context.user_id).all():
            assert row.json["spec"]["status"] == "disconnected"
            assert row.json["spec"]["credential"] is None
            assert row.json["spec"]["deviceGrants"] == {}


@pytest.mark.parametrize("first", ["uninstall", "login"])
def test_uninstall_and_local_login_never_restore_an_inactive_plugin(
    local_context, first
):
    context = local_context
    login = lambda db: lifecycle(context, db, "login")
    remove = lambda db: uninstall(context, db)
    winner, waiting = run_ordered(
        context,
        remove if first == "uninstall" else login,
        login if first == "uninstall" else remove,
    )
    if first == "uninstall":
        assert winner is None and waiting == "plugin_auth_plugin_not_found"
    else:
        assert winner == {"status": "ok"} and waiting is None
    with context.sessions() as db:
        assert db.get(Kind, context.plugin_id).is_active is False
        assert context.accounts.list_connections(db, user_id=context.user_id) == []
        with pytest.raises(
            PluginAccountAuthError, match="plugin_auth_plugin_not_found"
        ):
            lifecycle(context, db, "login")


def upload_package() -> bytes:
    manifest = {
        "name": "concurrent-upload",
        "version": "1.0.0",
        "interface": {"displayName": "Concurrent upload", "shortDescription": "Test"},
    }
    output = io.BytesIO()
    with ZipFile(output, "w") as archive:
        archive.writestr(".codex-plugin/plugin.json", json.dumps(manifest))
        archive.writestr("commands/test.md", "# Synthetic test command")
    return output.getvalue()


def test_concurrent_real_package_installs_reuse_one_installation_and_binary(context):
    package, ids = upload_package(), []

    def install(db):
        installed = InstalledPluginService().upload_plugin(
            db=db,
            user_id=context.user_id,
            package_bytes=package,
            filename="concurrent-upload.zip",
        )
        ids.append(int(installed.metadata["labels"]["id"]))

    assert race(context, install, install) == ["ok", "ok"]
    assert len(ids) == 2 and len(set(ids)) == 1
    with context.sessions() as db:
        rows = (
            db.query(Kind)
            .filter_by(
                user_id=context.user_id,
                namespace="default",
                kind="InstalledPlugin",
            )
            .filter(
                Kind.json["spec"]["source"]["pluginKey"].as_string()
                == "concurrent-upload"
            )
            .all()
        )
        assert len(rows) == 1 and rows[0].is_active
        assert rows[0].id == ids[0]
        assert rows[0].json["spec"]["source"]["type"] == "upload"
        assert db.query(SkillBinary).filter_by(kind_id=ids[0]).count() == 1


def test_expired_first_upload_rolls_back_its_install_and_binary_after_successor_commit(
    context, monkeypatch
):
    package = upload_package()
    service = InstalledPluginService()
    client = coordination._redis_client()
    with context.sessions() as stale:
        # Pause the real upload at its commit boundary after both INSERTs execute.
        with monkeypatch.context() as patch:
            patch.setattr(stale, "commit", stale.flush)
            old_install = service.upload_plugin(
                db=stale,
                user_id=context.user_id,
                package_bytes=package,
                filename="concurrent-upload.zip",
            )
        old_id = int(old_install.metadata["labels"]["id"])
        assert stale.query(SkillBinary).filter_by(kind_id=old_id).count() == 1
        lease = stale.info["plugin_write_leases"][
            (context.user_id, service._safe_kind_name("concurrent-upload"))
        ]
        # A process can pause immediately after its last successful Redis check.
        lease.check = lambda: None
        assert client.pexpire(
            lock_key(context, service._safe_kind_name("concurrent-upload")), 100
        )

        with context.sessions() as successor:
            recovered = service.upload_plugin(
                db=successor,
                user_id=context.user_id,
                package_bytes=package,
                filename="concurrent-upload.zip",
            )
        recovered_id = int(recovered.metadata["labels"]["id"])
        assert recovered_id != old_id

        with pytest.raises(PluginWriteError, match="plugin_write_conflict"):
            stale.commit()
        stale.rollback()

    with context.sessions() as db:
        rows = (
            db.query(Kind)
            .filter(
                Kind.user_id == context.user_id,
                Kind.kind == "InstalledPlugin",
                Kind.namespace == "default",
                Kind.json["spec"]["source"]["pluginKey"].as_string()
                == "concurrent-upload",
            )
            .all()
        )
        assert len(rows) == 1 and rows[0].id == recovered_id and rows[0].is_active
        assert rows[0].json["spec"]["revision"] == 1
        assert db.get(Kind, old_id) is None
        assert db.query(SkillBinary).filter_by(kind_id=old_id).count() == 0
        binaries = (
            db.query(SkillBinary)
            .join(Kind, Kind.id == SkillBinary.kind_id)
            .filter(Kind.user_id == context.user_id)
            .all()
        )
        assert len(binaries) == 1 and binaries[0].kind_id == recovered_id
    assert not client.exists(
        lock_key(context, service._safe_kind_name("concurrent-upload"))
    )


def test_stale_automation_cannot_insert_an_intent_after_logout_commits(
    local_context, monkeypatch
):
    context = local_context
    automation = PluginAuthAutomationService(context.accounts)
    client = coordination._redis_client()
    write_intent = automation.migrations._write_intent
    logout_completed = threading.Event()

    def logout_before_intent_insert(db: Session, user_id: int, spec: dict):
        # The real automation has already read the enabled local-auth policy.
        lease = db.info["plugin_write_leases"][(context.user_id, "mysql-auth-fixture")]
        lease.check = lambda: None
        assert client.pexpire(lock_key(context), 100)
        with context.sessions.begin() as successor:
            assert lifecycle(context, successor, "logout") == {"status": "ok"}
        logout_completed.set()
        return write_intent(db, user_id, spec)

    monkeypatch.setattr(
        automation.migrations, "_write_intent", logout_before_intent_insert
    )
    with context.sessions() as stale:
        result = automation.reconcile(
            stale,
            user_id=context.user_id,
            device_id=context.device_id,
            installed_ids=[context.plugin_id],
        )
        assert logout_completed.is_set()
        assert len(result["migrations"]) == 1
        assert (
            stale.query(Kind)
            .filter_by(user_id=context.user_id, kind="ConnectorMigration")
            .count()
            == 1
        )

        with pytest.raises(PluginWriteError, match="plugin_write_conflict"):
            stale.commit()
        stale.rollback()

    with context.sessions.begin() as db:
        assert (
            db.query(Kind)
            .filter_by(user_id=context.user_id, kind="ConnectorMigration")
            .count()
            == 0
        )
        assert context.accounts.list_connections(db, user_id=context.user_id) == []
        assert lifecycle(context, db, "status") == {"status": "need_login"}
        assert automation.reconcile(
            db,
            user_id=context.user_id,
            device_id=context.device_id,
            installed_ids=[context.plugin_id],
        ) == {"migrations": []}
    assert not client.exists(lock_key(context))


def test_stale_ack_merge_preserves_newer_dispatch_counters_on_real_mysql(context):
    from app.services.device.plugin_sync_protocol import (
        advance_plugin_snapshot_watermark,
        lock_plugin_sync_state,
        plugin_snapshot_watermark,
        register_plugin_snapshot_intent,
    )

    with context.sessions() as db:
        lock_plugin_sync_state(db, context.user_id)
        db.commit()
    with context.sessions() as acknowledgement:
        state = lock_plugin_sync_state(acknowledgement, context.user_id, merge=True)
        advance_plugin_snapshot_watermark(
            state,
            "device.with.dot",
            generation=2,
            complete=True,
            installed_plugin_ids=[context.plugin_id],
        )
        register_plugin_snapshot_intent(
            context.sessions,
            user_id=context.user_id,
            device_id="device.with.dot",
            payload={
                "plugins": [{"installed_plugin_id": context.plugin_id}],
                "plugin_sync": {"version": 2, "generation": 9, "complete": True},
            },
        )
        acknowledgement.commit()
    with context.sessions() as db:
        state = lock_plugin_sync_state(db, context.user_id)
        assert state.json["spec"]["generation"] == 9
        assert (
            plugin_snapshot_watermark(state, "device.with.dot", context.plugin_id) == 9
        )


def test_parallel_ack_metadata_commits_need_no_global_revision_retry(context):
    from app.services.device.plugin_sync_protocol import (
        advance_plugin_snapshot_watermark,
        lock_plugin_sync_state,
    )

    with context.sessions() as db:
        lock_plugin_sync_state(db, context.user_id)
        db.commit()
    read = threading.Barrier(4)

    def acknowledge(index):
        with context.sessions() as db:
            state = lock_plugin_sync_state(db, context.user_id, merge=True)
            advance_plugin_snapshot_watermark(
                state,
                f"peer-{index}",
                generation=index + 1,
                complete=False,
                installed_plugin_ids=[context.plugin_id],
            )
            read.wait(timeout=10)
            db.commit()

    with ThreadPoolExecutor(max_workers=4) as pool:
        pending = [pool.submit(acknowledge, index) for index in range(4)]
        for future in pending:
            future.result(timeout=15)
    with context.sessions() as db:
        state = lock_plugin_sync_state(db, context.user_id)
        assert state.json["spec"]["generation"] == 4
        for index in range(4):
            assert (
                state.json["spec"]["devices"][f"peer-{index}"]["plugins"][
                    str(context.plugin_id)
                ]
                == index + 1
            )


def test_compactor_skips_unresolved_parents_before_its_mysql_batch_limit(context):
    from scripts.compact_plugin_auth_migrations import compact_batch

    with context.sessions() as db:
        rows = []
        for parent in ([], context.plugin_id, context.plugin_id):
            row = Kind(
                user_id=context.user_id,
                kind="ConnectorMigration",
                namespace="plugin-auth",
                name=uuid.uuid4().hex,
                is_active=False,
                json={
                    "spec": {
                        "automatic": True,
                        "source_identity": "compactor-fixture",
                        "connector_slug": "test",
                        "device_id": context.device_id,
                        "expires_at": 1,
                        "installed_plugin_id": parent,
                    }
                },
            )
            db.add(row)
            rows.append(row)
        db.commit()
        ids = [row.id for row in rows]
        assert compact_batch(db, context.user_id, 1) == 1
        db.commit()
        assert set(id for id, in db.query(Kind.id).filter(Kind.id.in_(ids))) == {
            ids[0],
            ids[2],
        }


def test_real_mysql_rejects_ack_device_writes_after_a_newer_dispatch(context):
    from app.models.plugin_marketplace import PluginDeviceInstallation
    from app.services.device.plugin_sync_protocol import (
        advance_plugin_snapshot_watermark,
        lock_plugin_sync_state,
        register_plugin_snapshot_intent,
    )
    from app.services.plugin_sync_revision import remember_ack_watermark

    PluginDeviceInstallation.__table__.create(
        context.sessions.kw["bind"], checkfirst=True
    )
    with context.sessions() as db:
        lock_plugin_sync_state(db, context.user_id)
        db.add(
            PluginDeviceInstallation(
                user_id=context.user_id,
                installed_kind_id=context.plugin_id,
                device_id="ack-fence",
                state="failed",
                attempt_count=2,
            )
        )
        db.commit()
    with context.sessions() as acknowledgement:
        state = lock_plugin_sync_state(acknowledgement, context.user_id, merge=True)
        remember_ack_watermark(
            acknowledgement, state, "ack-fence", context.plugin_id, 7
        )
        row = (
            acknowledgement.query(PluginDeviceInstallation)
            .filter_by(user_id=context.user_id, device_id="ack-fence")
            .one()
        )
        row.attempt_count = 3
        register_plugin_snapshot_intent(
            context.sessions,
            user_id=context.user_id,
            device_id="ack-fence",
            payload={
                "plugins": [{"installed_plugin_id": context.plugin_id}],
                "plugin_sync": {"version": 2, "generation": 8, "complete": False},
            },
        )
        advance_plugin_snapshot_watermark(
            state,
            "ack-fence",
            generation=7,
            complete=False,
            installed_plugin_ids=[context.plugin_id],
        )
        with pytest.raises(PluginWriteError, match="plugin_write_conflict"):
            acknowledgement.commit()
        acknowledgement.rollback()
    with context.sessions() as db:
        row = (
            db.query(PluginDeviceInstallation)
            .filter_by(user_id=context.user_id, device_id="ack-fence")
            .one()
        )
        assert row.attempt_count == 2
        db.delete(row)
        db.commit()


def test_first_plugin_state_commit_outlives_redis_without_duplicate_or_cross_plugin_block(
    context, monkeypatch
):
    """Pause the real unique-key INSERT's COMMIT, then expire its real Redis lease."""
    from app.models.plugin_state import PluginState
    from app.services import plugin_state_store as store
    from app.services.plugin_write_resources import policy_engine

    owner = context.user_id
    key = f"bootstrap-{uuid.uuid4().hex}"
    other_key = f"{key}-other"
    client = coordination._redis_client()
    bootstrap = policy_engine(context.sessions.kw["bind"])
    committing, release, successor_entered = (threading.Event() for _ in range(3))
    first_thread = None
    original_claim = store.claim_plugin_identity

    def claim(db, user_id, plugin_key, installed_kind_id=0):
        if user_id == owner and plugin_key == key:
            if threading.get_ident() == first_thread:
                original_claim(db, user_id, plugin_key, installed_kind_id)
                db.connection().info["pause_plugin_state_commit"] = True
                return
            successor_entered.set()
        original_claim(db, user_id, plugin_key, installed_kind_id)

    def pause(connection):
        if connection.info.pop("pause_plugin_state_commit", False):
            committing.set()
            assert release.wait(5), "Plugin state COMMIT gate was not released"

    def initialize(name, first=False):
        nonlocal first_thread
        if first:
            first_thread = threading.get_ident()
        with context.sessions() as db:
            acquire_plugin_write_lock(db, owner, name=name)
            state = (
                db.query(PluginState).filter_by(user_id=owner, plugin_key=name).one()
            )
            identity = state.id
            db.commit()
            return identity

    monkeypatch.setattr(store, "claim_plugin_identity", claim)
    event.listen(bootstrap, "commit", pause)
    try:
        with ThreadPoolExecutor(max_workers=3) as pool:
            old = pool.submit(initialize, key, True)
            try:
                assert committing.wait(5), "First initializer did not reach COMMIT"
                redis_key = f"wegent:plugin-write:{owner}:{key}"
                assert client.pexpire(redis_key, 100)
                successor = pool.submit(initialize, key)
                assert successor_entered.wait(
                    3
                ), "Successor did not acquire expired lease"
                assert (
                    not successor.done()
                ), "Unique-key insert did not fence uncertain COMMIT"
                independent = pool.submit(initialize, other_key).result(timeout=2)
                assert independent > 0 and not release.is_set()
            finally:
                release.set()
            with pytest.raises(PluginWriteError, match="plugin_write_lease_lost"):
                old.result(timeout=5)
            winner = successor.result(timeout=5)
        with context.sessions() as db:
            rows = db.query(PluginState).filter_by(user_id=owner, plugin_key=key).all()
            assert len(rows) == 1 and rows[0].id == winner
            assert (
                not db.query(PluginState)
                .filter_by(user_id=owner, plugin_key="@legacy-v2")
                .count()
            )
    finally:
        release.set()
        event.remove(bootstrap, "commit", pause)


@pytest.mark.parametrize("rename", [False, True])
def test_delayed_backfill_never_overwrites_foreground_state_or_revives_an_old_name(
    context, rename
):
    """Pause after projection; let a real foreground transaction commit first."""
    from app.models.plugin_state import PluginState
    from app.services.device.plugin_sync_protocol import lock_installed_plugin_state
    from app.services.plugin_write_resources import policy_engine
    from scripts.backfill_plugin_states import backfill_one

    old_name = "mysql-auth-fixture"
    legacy = {
        "spec": {
            "generation": 7677,
            "devices": {"desktop": {"plugins": {str(context.plugin_id): 7000}}},
            "localIntentOrders": {"native": {str(context.plugin_id): 7}},
        }
    }
    with context.sessions.begin() as db:
        db.add(
            Kind(
                user_id=context.user_id,
                kind="PluginSyncState",
                namespace="plugin-sync",
                name="account",
                json=legacy,
                is_active=True,
            )
        )
    projected, release = threading.Event(), threading.Event()
    worker_id = None

    def pause(_connection, _cursor, statement, _parameters, _execution, _many):
        if threading.get_ident() == worker_id and statement.startswith(
            "INSERT INTO plugin_states"
        ):
            projected.set()
            assert release.wait(10), "Backfill insert was not released"

    def fill():
        nonlocal worker_id
        worker_id = threading.get_ident()
        with context.sessions() as db:
            return backfill_one(
                db, context.plugin_id, context.user_id, "InstalledPlugin", True
            )

    bootstrap = policy_engine(context.sessions.kw["bind"])
    event.listen(bootstrap, "before_cursor_execute", pause)
    try:
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(fill)
            try:
                assert projected.wait(5), "Backfill did not reach its real INSERT"
                with context.sessions() as db:
                    acquire_plugin_write_lock(
                        db, context.user_id, installed_id=context.plugin_id
                    )
                    if rename:
                        parent = db.get(Kind, context.plugin_id)
                        replace_installed_kind(
                            db, parent, parent.json, name="renamed-plugin"
                        )
                    state = lock_installed_plugin_state(
                        db, context.user_id, context.plugin_id
                    )
                    document = deepcopy(state.json)
                    document["spec"]["generation"] = 9000
                    document["spec"]["localIntentOrders"]["native"][
                        str(context.plugin_id)
                    ] = 99
                    state.json = document
                    db.commit()
                    expected = deepcopy(state.json)
            finally:
                release.set()
            if rename:
                with pytest.raises(PluginWriteError, match="plugin_write_conflict"):
                    pending.result(timeout=5)
            else:
                assert pending.result(timeout=5) == "initialized_or_concurrent"
        with context.sessions() as db:
            states = (
                db.query(PluginState)
                .filter_by(user_id=context.user_id, installed_kind_id=context.plugin_id)
                .all()
            )
            assert len(states) == 1
            assert states[0].plugin_key == ("renamed-plugin" if rename else old_name)
            assert states[0].json == expected
            assert (
                db.query(Kind)
                .filter_by(
                    user_id=context.user_id,
                    kind="PluginSyncState",
                    namespace="plugin-sync",
                    name="account",
                )
                .one()
                .json
                == legacy
            )
    finally:
        release.set()
        event.remove(bootstrap, "before_cursor_execute", pause)
