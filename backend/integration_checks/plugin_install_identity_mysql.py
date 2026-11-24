"""Real HTTP, JWT, MySQL and Redis checks for existing installation identities."""

import logging
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from copy import deepcopy

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import event

from app.api.dependencies import get_db
from app.api.endpoints.installed_plugins import router
from app.core.security import create_access_token
from app.models.kind import Kind
from app.models.plugin_marketplace import (
    Plugin,
    PluginDeviceInstallation,
    PluginRelease,
    PluginSubmission,
)
from app.models.plugin_publication import PluginPublicationRequest
from app.models.resource_member import ResourceMember
from app.models.user import User
from app.services import (
    plugin_device_sync,
)
from app.services import plugin_marketplace_service as marketplace
from app.services import (
    plugin_write_coordination,
    plugin_write_operations,
)
from app.services.device.plugin_sync_protocol import lock_plugin_sync_state
from app.services.installed_plugin_service import installed_plugin_service
from app.services.plugin_local_sync import mutate_local_plugin
from app.services.plugin_marketplace_identity import (
    ENTERPRISE_CATALOG_NAMESPACE,
    personal_catalog_namespace,
)
from app.services.plugin_marketplace_service import plugin_marketplace_service
from app.services.plugin_write_coordination import PluginWriteError


def _seed_catalog(context, active: bool, warm_state: bool):
    engine = context.sessions.kw["bind"]
    for model in (Plugin, PluginRelease, PluginDeviceInstallation):
        model.__table__.create(engine, checkfirst=True)
    with context.sessions.begin() as db:
        slug = f"identity-{uuid.uuid4().hex}"
        plugin = Plugin(
            catalog_namespace=ENTERPRISE_CATALOG_NAMESPACE,
            slug=slug,
            name=slug,
            owner_user_id=context.user_id,
            visibility="workspace",
            status="published",
        )
        db.add(plugin)
        db.flush()
        release = PluginRelease(
            plugin_id=plugin.id,
            version="1.0.0",
            manifest_json={"name": slug, "version": "1.0.0"},
            storage_key="synthetic-identity.zip",
            sha256="a" * 64,
            size_bytes=1,
            status="ready",
            scan_status="passed",
            scan_report_json={"components": {}},
        )
        db.add(release)
        db.flush()
        plugin.latest_release_id = release.id
        installed = db.get(Kind, context.plugin_id)
        installed.name = installed_plugin_service._safe_kind_name(slug)
        installed.json = plugin_marketplace_service._installed_payload(plugin, release)
        installed.is_active = active
        # This account has no registered runtime; background enumeration stays real.
        db.query(Kind).filter_by(user_id=context.user_id, kind="Device").delete()
        plugin_id, name = plugin.id, installed.name
    if not warm_state:
        return plugin_id, slug, name, None
    with context.sessions() as db:
        state = lock_plugin_sync_state(db, context.user_id)
        document = deepcopy(state.json)
        document["spec"].update(
            generation=41,
            devices={"peer": {"plugins": {str(context.plugin_id): 40}}},
            localIntentOrders={"peer": {str(context.plugin_id): 9}},
        )
        state.json = document
        db.commit()
        state_id = state.id
    return plugin_id, slug, name, state_id


@pytest.mark.parametrize("entry", ["marketplace", "builtin"])
@pytest.mark.parametrize("active", [True, False])
@pytest.mark.parametrize("warm_state", [True, False])
def test_http_reinstall_uses_existing_identity_with_real_mysql_and_redis(
    context, monkeypatch, caplog, entry, active, warm_state
):
    plugin_id, slug, name, state_id = _seed_catalog(context, active, warm_state)

    @contextmanager
    def worker_db():
        with context.sessions() as db:
            yield db

    def request_db():
        with context.sessions() as db:
            yield db

    # Route all database work, including the real background task, to the
    # disposable schema. Authentication and business services are unchanged.
    monkeypatch.setattr(plugin_write_operations, "get_db_session", worker_db)
    monkeypatch.setattr(plugin_device_sync, "get_db_session", worker_db)
    monkeypatch.setenv("PLUGIN_LOCAL_SYNC_ENABLED", "true")
    app = FastAPI()
    app.include_router(router, prefix="/api/plugins")
    app.dependency_overrides[get_db] = request_db
    with context.sessions() as db:
        username = db.get(User, context.user_id).user_name
    token = create_access_token({"sub": username})
    derived = plugin_marketplace_service._kind_name(ENTERPRISE_CATALOG_NAMESPACE, slug)
    client = plugin_write_coordination._redis_client()
    held = client.lock(
        f"wegent:plugin-write:{context.user_id}:{derived}",
        timeout=30,
        blocking_timeout=0,
        thread_local=False,
    )
    assert held.acquire()
    try:
        caplog.set_level(logging.ERROR)
        path = (
            f"/api/plugins/marketplace/{plugin_id}/install"
            if entry == "marketplace"
            else f"/api/plugins/builtin/{slug}/ensure-installed"
        )
        with TestClient(app) as http:
            options = dict(
                headers={"Authorization": f"Bearer {token}"},
                params={
                    "delivery_mode": "local_pull_v1",
                    "local_instance_id": "mysql-identity",
                    "operation_id": "reinstall-legacy-name",
                    "local_intent_order": 1,
                },
            )
            if entry == "builtin":
                options["json"] = {}
            response = http.post(path, **options)
            assert response.status_code == 200, response.text
            body = response.json()
            result = body["plugin"]
            assert int(result["metadata"]["labels"]["id"]) == context.plugin_id
            replay = http.post(path, **options)
            assert replay.status_code == 200 and replay.json() == body
        assert held.owned()
        assert not [
            record.message
            for record in caplog.records
            if record.levelno >= logging.ERROR
        ]
        with context.sessions() as db:
            parent = db.get(Kind, context.plugin_id)
            assert parent.name == name and parent.is_active
            states = (
                db.query(Kind)
                .filter_by(
                    user_id=context.user_id,
                    kind="PluginSyncState",
                    namespace="plugin-sync",
                    name="account",
                )
                .all()
            )
            assert len(states) == 1
            if warm_state:
                assert states[0].id == state_id
            spec = states[0].json["spec"]
            assert spec["generation"] == (41 if warm_state else 0)
            if warm_state:
                assert spec["localIntentOrders"]["peer"] == {str(context.plugin_id): 9}
            assert (
                spec["localIntents"]["mysql-identity"][str(context.plugin_id)][
                    "operationId"
                ]
                == "reinstall-legacy-name"
            )
    finally:
        held.release()
        with context.sessions.begin() as db:
            db.query(PluginRelease).filter_by(plugin_id=plugin_id).delete()
            db.query(Plugin).filter_by(id=plugin_id).delete()


@pytest.mark.parametrize("entry", ["account", "local"])
@pytest.mark.parametrize("repair_race", [False, True])
def test_private_restore_and_delete_use_one_lock_order(
    context, monkeypatch, entry, repair_race
):
    """A restore waiting at the catalog must not hold deletion's installation lease."""
    engine = context.sessions.kw["bind"]
    for model in (PluginSubmission, PluginPublicationRequest, ResourceMember):
        model.__table__.create(engine, checkfirst=True)
    plugin_id, _, _, _ = _seed_catalog(context, active=True, warm_state=False)
    service = plugin_marketplace_service
    with context.sessions.begin() as db:
        plugin = db.get(Plugin, plugin_id)
        plugin.visibility = "personal"
        plugin.catalog_namespace = personal_catalog_namespace(context.user_id)
        installed = db.get(Kind, context.plugin_id)
        installed.name = service._kind_name(plugin.catalog_namespace, plugin.slug)
        installed.json = service._installed_payload(
            plugin, db.get(PluginRelease, plugin.latest_release_id)
        )
        release_id = plugin.latest_release_id
        if repair_race:
            payload = deepcopy(installed.json)
            payload["spec"]["releaseId"] = release_id + 1_000_000_000
            payload["spec"]["source"]["providerKey"] = "legacy-marketplace"
            installed.json = payload
    with context.sessions() as db:
        impact = service.get_personal_plugin_delete_impact(
            db, plugin_id=plugin_id, user_id=context.user_id
        )
    monkeypatch.setenv("PLUGIN_LOCAL_SYNC_ENABLED", "true")
    restoring = threading.local()
    catalog_requested, deleted = threading.Event(), threading.Event()
    operation_id = uuid.uuid4().hex
    acquire_leases = marketplace.acquire_plugin_write_locks
    repaired = False

    def finish_another_repair_before_leasing(db, installations):
        nonlocal repaired
        targets = list(installations)
        if (
            repair_race
            and targets
            and getattr(restoring, "active", False)
            and not repaired
            and not catalog_requested.is_set()
        ):
            repaired = True
            with context.sessions() as other:
                assert (
                    service.reconcile_stale_installed_catalog_refs(
                        other, user_id=context.user_id, plugin_id=plugin_id
                    )
                    == 1
                )
        return acquire_leases(db, targets)

    monkeypatch.setattr(
        marketplace, "acquire_plugin_write_locks", finish_another_repair_before_leasing
    )

    def hold_restore_before_catalog(_conn, _cursor, statement, _params, _ctx, _many):
        if (
            getattr(restoring, "active", False)
            and not catalog_requested.is_set()
            and statement.startswith("SELECT plugins.")
            and "FOR UPDATE" in statement
        ):
            catalog_requested.set()
            assert deleted.wait(
                10
            ), "Deletion did not settle while restore awaited its row"

    def restore():
        restoring.active = True
        with context.sessions() as db:
            if entry == "local":
                result = mutate_local_plugin(
                    db,
                    user_id=context.user_id,
                    instance_id="private-restore-race",
                    operation_id=operation_id,
                    intent_order=1,
                    action="install",
                    target_id=plugin_id,
                    payload={"restoreDeleted": True},
                )
                return int(result["metadata"]["labels"]["id"])
            result = service.install(
                db,
                user_id=context.user_id,
                plugin_id=plugin_id,
                restore_deleted=True,
            )
            return int(result.metadata["labels"]["id"])

    def delete():
        try:
            with context.sessions() as db:
                service.delete_owned_personal_plugin(
                    db,
                    plugin_id=plugin_id,
                    user_id=context.user_id,
                    impact_revision=impact.impactRevision,
                    revoke_and_delete=False,
                )
            return "ok"
        except PluginWriteError as error:
            return error.code
        finally:
            deleted.set()

    event.listen(engine, "before_cursor_execute", hold_restore_before_catalog)
    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            pending_restore = pool.submit(restore)
            try:
                assert catalog_requested.wait(
                    5
                ), "Restore did not reach its catalog lock"
                pending_delete = pool.submit(delete)
                delete_result = pending_delete.result(timeout=10)
                assert delete_result == "ok", delete_result
                assert pending_restore.result(timeout=10) == context.plugin_id
            finally:
                deleted.set()
        with context.sessions() as db:
            assert db.get(Plugin, plugin_id).status == "published"
            installed = db.get(Kind, context.plugin_id)
            assert installed.is_active
            assert installed.json["spec"]["releaseId"] == release_id
        if entry == "local":
            with context.sessions.begin() as db:
                db.get(Plugin, plugin_id).status = "unpublished"
            with context.sessions() as db:
                replay = mutate_local_plugin(
                    db,
                    user_id=context.user_id,
                    instance_id="private-restore-race",
                    operation_id=operation_id,
                    intent_order=1,
                    action="install",
                    target_id=plugin_id,
                    payload={"restoreDeleted": True},
                )
                assert int(replay["metadata"]["labels"]["id"]) == context.plugin_id
                assert db.get(Plugin, plugin_id).status == "unpublished"
    finally:
        event.remove(engine, "before_cursor_execute", hold_restore_before_catalog)
        with context.sessions.begin() as db:
            db.query(PluginRelease).filter_by(plugin_id=plugin_id).delete()
            db.query(Plugin).filter_by(id=plugin_id).delete()
