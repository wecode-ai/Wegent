"""Opt-in account writes do not enumerate or wait for registered Devices."""

from contextlib import contextmanager
from datetime import datetime, timedelta
from unittest.mock import Mock

import pytest
from fastapi import HTTPException
from sqlalchemy import event

from app.models.kind import Kind
from app.models.plugin_local_sync import PluginLocalSyncOperation, PluginSyncOutbox
from app.services import plugin_sync_outbox
from app.services.plugin_marketplace_service import plugin_marketplace_service
from tests.api.test_plugin_write_operations import plugin_requests  # noqa: F401


@pytest.mark.parametrize("enabled", ["true", "false"])
@pytest.mark.parametrize(
    "entry", ["marketplace", "builtin", "legacy", "release", "state", "uninstall"]
)
def test_legacy_writes_do_not_access_new_tables(
    plugin_requests, monkeypatch, enabled, entry
):
    c = plugin_requests
    from app.services.device import plugin_removal_sync

    @contextmanager
    def session():
        with c.sessions() as db:
            yield db

    monkeypatch.setattr(plugin_removal_sync, "get_db_session", session)
    monkeypatch.setenv("PLUGIN_LOCAL_SYNC_ENABLED", enabled)
    if entry in {"release", "state", "uninstall"}:
        c.seed_update()
    engine = c.sessions.kw["bind"]

    def reject_new_tables(conn, cursor, statement, parameters, context, executemany):
        assert "plugin_local_sync_operations" not in statement.lower()
        assert "plugin_sync_outbox" not in statement.lower()

    event.listen(engine, "before_cursor_execute", reject_new_tables)
    try:
        response = (
            c.client.delete(f"/plugins/installed/{c.installed_id}")
            if entry == "uninstall"
            else c.write(entry)
        )
        assert response.status_code == (
            204 if entry == "uninstall" else 200
        ), response.text
        assert "X-Plugin-Delivery-Mode" not in response.headers
        c.run_background()
    finally:
        event.remove(engine, "before_cursor_execute", reject_new_tables)


@pytest.fixture
def local_context(plugin_requests, monkeypatch):
    monkeypatch.setenv("PLUGIN_LOCAL_SYNC_ENABLED", "true")
    with plugin_requests.sessions.begin() as db:
        db.query(Kind).filter_by(kind="Device").delete()
    return plugin_requests


def query(operation, order=1):
    return {
        "delivery_mode": "local_pull_v1",
        "local_instance_id": "local:one",
        "operation_id": operation,
        "local_intent_order": order,
    }


def install(context, operation="install:1"):
    return context.client.post(
        f"/plugins/marketplace/{context.plugin_id}/install", params=query(operation)
    )


def test_install_update_remove_without_device_and_without_rpc(local_context):
    c = local_context
    response = install(c)
    assert response.status_code == 200, response.text
    assert response.headers["X-Plugin-Delivery-Mode"] == "local_pull_v1"
    installed = int(response.json()["plugin"]["metadata"]["labels"]["id"])
    response = c.client.put(
        f"/plugins/installed/{installed}",
        params=query("update:1", 2),
        json={"releaseId": c.upgraded_release_id},
    )
    assert response.status_code == 200, response.text
    assert response.json()["spec"]["releaseId"] == c.upgraded_release_id
    response = c.client.delete(
        f"/plugins/installed/{installed}", params=query("delete:1", 3)
    )
    assert response.status_code == 204 and response.content == b""
    assert response.headers["X-Plugin-Operation-Id"] == "delete:1"
    assert c.remote_calls == [] and c.background_tasks == []
    with c.sessions() as db:
        assert db.query(PluginLocalSyncOperation).count() == 3
        assert db.query(PluginSyncOutbox).count() == 3
        assert not db.get(Kind, installed).is_active


def test_replay_is_idempotent_and_different_payload_conflicts(local_context):
    c = local_context
    first = install(c).json()
    assert install(c).json() == first
    response = c.client.post(
        f"/plugins/marketplace/{c.plugin_id}/install",
        params={**query("install:1"), "release_id": c.upgraded_release_id},
    )
    assert (
        response.status_code == 409
        and response.json()["detail"] == "IDEMPOTENCY_CONFLICT"
    )
    with c.sessions() as db:
        assert db.query(PluginSyncOutbox).count() == 1
        assert db.query(PluginLocalSyncOperation).count() == 1


def test_outbox_failure_rolls_back_account_and_operation(local_context):
    c = local_context

    def fail(*args):
        raise RuntimeError("outbox storage failed")

    event.listen(PluginSyncOutbox, "before_insert", fail)
    try:
        with pytest.raises(RuntimeError, match="outbox storage failed"):
            install(c)
    finally:
        event.remove(PluginSyncOutbox, "before_insert", fail)
    with c.sessions() as db:
        assert db.query(PluginLocalSyncOperation).count() == 0
        assert db.query(PluginSyncOutbox).count() == 0
        assert (
            db.query(Kind)
            .filter_by(user_id=c.user_id, kind="InstalledPlugin", is_active=True)
            .count()
            == 0
        )

    with c.sessions() as db:
        assert (
            db.query(Kind)
            .filter_by(
                user_id=c.user_id,
                kind="PluginSyncState",
                namespace="plugin-sync",
                name="account",
            )
            .count()
            == 0
        )
    assert install(c).status_code == 200


def test_disabled_acceptance_cannot_silently_run_legacy(plugin_requests, monkeypatch):
    monkeypatch.setenv("PLUGIN_LOCAL_SYNC_ENABLED", "false")
    response = install(plugin_requests)
    assert response.status_code == 409
    assert plugin_requests.account() is None
    assert plugin_requests.remote_calls == []


def test_expected_release_rejects_drift_before_storage(local_context, monkeypatch):
    c = local_context
    installed = int(install(c).json()["plugin"]["metadata"]["labels"]["id"])
    storage = Mock(side_effect=AssertionError("must not download an unrelated release"))
    monkeypatch.setattr(
        "app.services.plugin_marketplace_service.plugin_package_storage.get", storage
    )
    with c.sessions() as db, pytest.raises(HTTPException) as exc:
        plugin_marketplace_service.release_package_for_install(
            db,
            user_id=c.user_id,
            installed_id=installed,
            expected_release_id=c.upgraded_release_id,
        )
    assert exc.value.status_code == 409 and exc.value.detail == "RELEASE_CHANGED"
    storage.assert_not_called()


def test_worker_reclaims_crash_and_fences_late_completion(local_context, monkeypatch):
    c = local_context
    install(c)

    @contextmanager
    def session():
        with c.sessions() as db:
            yield db

    monkeypatch.setattr(plugin_sync_outbox, "get_db_session", session)
    first = plugin_sync_outbox.claim_event()
    assert first and plugin_sync_outbox.claim_event() is None
    with c.sessions.begin() as db:
        db.get(PluginSyncOutbox, first[0]).lease_until = datetime.utcnow() - timedelta(
            seconds=1
        )
    second = plugin_sync_outbox.claim_event()
    assert second and second[3] != first[3]
    plugin_sync_outbox.finish_event(first[0], first[3], True)
    with c.sessions() as db:
        assert db.get(PluginSyncOutbox, first[0]).state == "running"
    plugin_sync_outbox.finish_event(second[0], second[3], False)
    with c.sessions() as db:
        row = db.get(PluginSyncOutbox, first[0])
        assert row.state == "pending" and row.attempt_count == 2


def test_builtin_install_uses_the_same_atomic_local_path(local_context):
    c = local_context
    response = c.client.post(
        "/plugins/builtin/write-regression-legacy/ensure-installed",
        params=query("builtin:1"),
        json={},
    )
    assert response.status_code == 200, response.text
    assert response.headers["X-Plugin-Delivery-Mode"] == "local_pull_v1"
    assert c.remote_calls == [] and c.background_tasks == []
    with c.sessions() as db:
        assert db.query(PluginLocalSyncOperation).one().action == "ensure_builtin"
        assert db.query(PluginSyncOutbox).count() == 1


def test_claim_retains_optional_origin_without_requiring_registration(
    local_context, monkeypatch
):
    c = local_context
    response = c.client.post(
        f"/plugins/marketplace/{c.plugin_id}/install",
        params={**query("source:1"), "source_device_id": "unregistered-runtime"},
    )
    assert response.status_code == 200

    @contextmanager
    def session():
        with c.sessions() as db:
            yield db

    monkeypatch.setattr(plugin_sync_outbox, "get_db_session", session)
    claim = plugin_sync_outbox.claim_event()
    assert claim[4] == "unregistered-runtime"


@pytest.mark.asyncio
async def test_worker_does_not_send_the_change_back_to_the_origin(
    local_context, monkeypatch
):
    from unittest.mock import AsyncMock

    from app.schemas.device import DeviceCapabilitySyncResult

    c = local_context
    installed = int(install(c).json()["plugin"]["metadata"]["labels"]["id"])

    @contextmanager
    def session():
        with c.sessions() as db:
            yield db

    monkeypatch.setattr(plugin_sync_outbox, "get_db_session", session)
    monkeypatch.setattr(
        plugin_sync_outbox.device_service,
        "get_online_devices",
        AsyncMock(return_value=[{"device_id": "origin"}, {"device_id": "other"}]),
    )
    monkeypatch.setattr(
        plugin_sync_outbox.plugin_device_installation_service,
        "ensure_pending_for_all_devices",
        AsyncMock(),
    )
    dispatch = AsyncMock(
        return_value=DeviceCapabilitySyncResult(device_id="other", success=True)
    )
    monkeypatch.setattr(
        plugin_sync_outbox.device_capability_sync_service,
        "sync_plugin_change",
        dispatch,
    )
    monkeypatch.setattr(
        plugin_sync_outbox.plugin_device_installation_service,
        "record_device_sync_result",
        lambda db, **kwargs: None,
    )

    assert await plugin_sync_outbox.dispatch_event(c.user_id, installed, "origin")
    dispatch.assert_awaited_once_with(
        user_id=c.user_id, device_id="other", installed_plugin_ids=[installed]
    )


def test_rollback_allows_only_already_accepted_replay(local_context, monkeypatch):
    c = local_context
    accepted = install(c)
    assert accepted.status_code == 200
    monkeypatch.setenv("PLUGIN_LOCAL_SYNC_ENABLED", "false")
    assert install(c).json() == accepted.json()
    assert install(c, "new-operation").status_code == 409
    with c.sessions() as db:
        assert db.query(PluginLocalSyncOperation).count() == 1
        assert db.query(PluginSyncOutbox).count() == 1


def test_expired_snapshots_are_retired_but_pending_intents_are_kept(
    local_context, monkeypatch
):
    c = local_context
    old = datetime.utcnow() - timedelta(days=32)
    with c.sessions.begin() as db:
        for operation_id, action, state in [
            ("issued", "snapshot", "issued"),
            ("terminal", "snapshot", "local_completed"),
            ("intent", "install", "intent_saved"),
        ]:
            db.add(
                PluginLocalSyncOperation(
                    user_id=c.user_id,
                    instance_id="retention",
                    operation_id=operation_id,
                    action=action,
                    installed_id=1,
                    document={"state": state},
                    created_at=old,
                    updated_at=old,
                )
            )

    @contextmanager
    def session():
        with c.sessions() as db:
            yield db

    monkeypatch.setattr(plugin_sync_outbox, "get_db_session", session)
    plugin_sync_outbox.cleanup_completed()
    with c.sessions() as db:
        rows = {
            row.operation_id: row.document["state"]
            for row in db.query(PluginLocalSyncOperation).all()
        }
        assert rows == {"issued": "expired", "intent": "intent_saved"}


def test_first_arrival_old_remove_cannot_reverse_a_newer_update(local_context):
    c = local_context
    c.seed_update()
    url = f"/plugins/installed/{c.installed_id}"
    updated = c.client.put(
        url, params=query("new:update", 2), json={"releaseId": c.upgraded_release_id}
    )
    assert updated.status_code == 200, updated.text
    with c.sessions.begin() as db:
        # The ordering watermark must survive operation retention/archival.
        db.query(PluginLocalSyncOperation).delete()
    late = c.client.delete(url, params=query("old:remove", 1))
    assert late.status_code == 409 and late.json()["detail"] == "INTENT_SUPERSEDED"
    assert c.account().json["spec"]["releaseId"] == c.upgraded_release_id
    assert c.remote_calls == []
    with c.sessions() as db:
        assert db.query(PluginSyncOutbox).count() == 1


def test_late_install_cannot_reverse_a_newer_uninstall(local_context):
    c = local_context
    installed = int(install(c).json()["plugin"]["metadata"]["labels"]["id"])
    deleted = c.client.delete(
        f"/plugins/installed/{installed}", params=query("new:remove", 3)
    )
    assert deleted.status_code == 204
    late = c.client.post(
        f"/plugins/marketplace/{c.plugin_id}/install", params=query("old:install", 2)
    )
    assert late.status_code == 409 and late.json()["detail"] == "INTENT_SUPERSEDED"
    assert c.account() is None
    with c.sessions() as db:
        assert not db.get(Kind, installed).is_active
        assert db.query(PluginSyncOutbox).count() == 2


def test_ordering_is_scoped_to_the_owned_plugin_and_local_instance(local_context):
    c = local_context
    installed = int(install(c).json()["plugin"]["metadata"]["labels"]["id"])
    newer = c.client.put(
        f"/plugins/installed/{installed}",
        params=query("new:policy", 10),
        json={"enabled": False},
    )
    assert newer.status_code == 200
    other = c.client.put(
        f"/plugins/installed/{installed}",
        params={**query("other:policy", 1), "local_instance_id": "other-instance"},
        json={"enabled": True},
    )
    assert other.status_code == 200
    builtin = c.client.post(
        "/plugins/builtin/write-regression-legacy/ensure-installed",
        params=query("other:plugin", 1),
        json={},
    )
    assert builtin.status_code == 200, builtin.text


@pytest.mark.parametrize("order", [None, 0, -1, 2**63])
def test_local_writes_require_a_valid_persisted_order(local_context, order):
    c = local_context
    params = query("invalid:order")
    if order is None:
        params.pop("local_intent_order")
    else:
        params["local_intent_order"] = order
    result = c.client.post(f"/plugins/marketplace/{c.plugin_id}/install", params=params)
    assert result.status_code == 422
    assert c.account() is None


def test_accepted_old_replay_does_not_rewrite_new_intent_or_reuse_its_order(
    local_context,
):
    c = local_context
    initial = install(c)
    installed = int(initial.json()["plugin"]["metadata"]["labels"]["id"])
    update = c.client.put(
        f"/plugins/installed/{installed}",
        params=query("new:update", 2),
        json={"releaseId": c.upgraded_release_id},
    )
    assert update.status_code == 200
    replay = install(c)
    assert replay.json() == initial.json()
    assert replay.headers["X-Plugin-Intent-Order"] == "1"
    assert c.account().json["spec"]["releaseId"] == c.upgraded_release_id
    conflict = c.client.post(
        f"/plugins/marketplace/{c.plugin_id}/install", params=query("install:1", 3)
    )
    assert (
        conflict.status_code == 409
        and conflict.json()["detail"] == "IDEMPOTENCY_CONFLICT"
    )


def test_missing_catalog_is_explicitly_rejected_without_accepting_work(local_context):
    c = local_context
    response = c.client.post(
        "/plugins/marketplace/999999/install", params=query("deleted:catalog", 1)
    )
    assert response.status_code == 404
    assert response.headers["X-Plugin-Operation-State"] == "rejected"
    assert response.headers["X-Plugin-Operation-Id"] == "deleted:catalog"
    assert response.headers["X-Plugin-Intent-Order"] == "1"
    with c.sessions() as db:
        assert db.query(PluginLocalSyncOperation).count() == 0
        assert db.query(PluginSyncOutbox).count() == 0


@pytest.mark.parametrize(
    "status,detail",
    [
        (401, "Expired"),
        (408, "Timeout"),
        (409, "LOCAL_SYNC_DISABLED"),
        (429, "Throttled"),
        (500, "INTENT_SUPERSEDED"),
        (503, "Unavailable"),
    ],
)
def test_retryable_or_uncertain_failures_are_not_acknowledged_as_rejections(
    local_context, monkeypatch, status, detail
):
    c = local_context

    def fail(*args, **kwargs):
        raise HTTPException(status, detail)

    monkeypatch.setattr(plugin_marketplace_service, "install", fail)
    response = install(c)
    assert response.status_code == status
    assert "X-Plugin-Operation-State" not in response.headers


def test_previously_accepted_request_cannot_be_marked_unaccepted(
    local_context, monkeypatch
):
    from app.services import plugin_local_sync

    c = local_context
    assert install(c).status_code == 200
    acquired = False
    original_lock = plugin_local_sync.acquire_plugin_write_lock
    original_lookup = plugin_local_sync._lookup_operation

    def acquire(db, user_id):
        nonlocal acquired
        original_lock(db, user_id)
        acquired = True

    def lookup(*args):
        assert acquired, "Nonacceptance must be checked after serializing with writes"
        return original_lookup(*args)

    def fail(*args, **kwargs):
        raise HTTPException(403, "Temporarily inaccessible catalog")

    monkeypatch.setattr(
        plugin_marketplace_service, "reconcile_stale_installed_catalog_refs", fail
    )
    monkeypatch.setattr(plugin_local_sync, "acquire_plugin_write_lock", acquire)
    monkeypatch.setattr(plugin_local_sync, "_lookup_operation", lookup)
    response = install(c)
    assert response.status_code == 403
    assert "X-Plugin-Operation-State" not in response.headers
    with c.sessions() as db:
        assert db.query(PluginLocalSyncOperation).count() == 1


def test_rejection_without_write_coordination_is_still_uncertain(
    local_context, monkeypatch
):
    from app.services import plugin_local_sync
    from app.services.plugin_write_errors import PluginWriteError

    def fail_repair(*args, **kwargs):
        raise HTTPException(404, "Marketplace plugin not found")

    def fail_coordination(*args, **kwargs):
        raise PluginWriteError("plugin_write_busy")

    monkeypatch.setattr(
        plugin_marketplace_service,
        "reconcile_stale_installed_catalog_refs",
        fail_repair,
    )
    monkeypatch.setattr(
        plugin_local_sync, "acquire_plugin_write_lock", fail_coordination
    )
    response = install(local_context)
    assert response.status_code == 503
    assert response.json()["detail"] == "plugin_write_busy"
    assert "X-Plugin-Operation-State" not in response.headers
