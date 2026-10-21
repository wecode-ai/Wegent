"""Real Redis contention, worker loss, and plugin lifecycle interleavings."""

import io
import json
import multiprocessing
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from typing import Callable
from zipfile import ZipFile

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.models.kind import Kind
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
from app.services.plugin_credential_cipher import PluginCredentialCipher
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


def lock_key(context: Context) -> str:
    return f"wegent:plugin-write:{context.user_id}"


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
            acquire_plugin_write_lock(db, context.user_id)
            acquired.set()
            try:
                result = waiting(db)
                db.commit()
                return result
            except PluginAccountAuthError as error:
                db.rollback()
                return error.code

    with context.sessions() as holder, ThreadPoolExecutor(max_workers=1) as pool:
        acquire_plugin_write_lock(holder, context.user_id)
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
        token = client.get(lock_key(context))
        with context.sessions() as blocked:
            with pytest.raises(PluginWriteError) as failure:
                automation.configure(blocked, context.user_id, True)
            assert failure.value.code == "plugin_write_busy"
            assert failure.value.status_code == 503
            assert client.get(lock_key(context)) == token
            blocked.rollback()
        holder.rollback()

    assert not client.exists(lock_key(context))
    with context.sessions.begin() as retry:
        assert automation.configure(retry, context.user_id, True) == {"enabled": True}
    with context.sessions() as db:
        policies = automation._policy(db, context.user_id).all()
        assert len(policies) == 1 and policies[0].json["spec"]["enabled"] is True
    assert not client.exists(lock_key(context))


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
        lease = stale.info["plugin_write_leases"][context.user_id]
        # A process can pause immediately after its last successful Redis check.
        lease.check = lambda: None
        assert client.pexpire(lock_key(context), 100)

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
    assert not client.exists(lock_key(context))


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
        lease = db.info["plugin_write_leases"][context.user_id]
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
