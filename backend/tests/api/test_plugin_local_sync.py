"""Opt-in account writes do not enumerate or wait for registered Devices."""

from contextlib import contextmanager
from unittest.mock import Mock

import pytest
from fastapi import HTTPException
from sqlalchemy import event

from app.models.kind import Kind
from app.services import plugin_device_sync
from app.services.plugin_local_sync import _lookup_operation as lookup_operation


def markers(db, user):
    row = (
        db.query(Kind)
        .filter_by(
            user_id=user,
            kind="PluginSyncState",
            namespace="plugin-sync",
            name="account",
        )
        .one_or_none()
    )
    assert (
        db.query(Kind).filter_by(user_id=user, namespace="plugin-local-sync").count()
        == 0
    )
    return (row.json.get("spec", {}).get("localIntents", {}) if row else {}).get(
        "local:one", {}
    )


from app.services.plugin_marketplace_service import plugin_marketplace_service
from tests.api.test_plugin_write_operations import plugin_requests  # noqa: F401


@pytest.mark.parametrize("enabled", ["true", "false"])
@pytest.mark.parametrize(
    "entry", ["marketplace", "builtin", "legacy", "release", "state", "uninstall"]
)
def test_legacy_writes_do_not_create_local_recovery_records(
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
        with c.sessions() as db:
            assert len(markers(db, c.user_id)) == 0
    finally:
        event.remove(engine, "before_cursor_execute", reject_new_tables)


@pytest.fixture
def local_context(plugin_requests, monkeypatch):
    from app.services.device import plugin_removal_sync

    monkeypatch.setenv("PLUGIN_LOCAL_SYNC_ENABLED", "true")
    with plugin_requests.sessions.begin() as db:
        db.query(Kind).filter_by(kind="Device").delete()

    @contextmanager
    def session():
        with plugin_requests.sessions() as db:
            yield db

    monkeypatch.setattr(plugin_removal_sync, "get_db_session", session)
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


def test_long_identifiers_reuse_existing_account_state_and_preserve_isolation(
    local_context,
):
    c = local_context
    instance, operation = "i" * 128, "o" * 128
    accepted = c.client.post(
        f"/plugins/marketplace/{c.plugin_id}/install",
        params={**query(operation), "local_instance_id": instance},
    )
    assert accepted.status_code == 200
    with c.sessions() as db:
        saved = lookup_operation(db, c.user_id, instance, operation)
        assert saved["operationId"] == operation
        assert "plugin" not in saved
        assert lookup_operation(db, c.user_id + 1, instance, operation) is None
        assert lookup_operation(db, c.user_id, "other-instance", operation) is None
        assert not db.query(Kind).filter_by(namespace="plugin-local-sync").count()


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
    assert c.remote_calls == []
    assert len(c.background_tasks) == 3
    assert all(
        task.func is plugin_device_sync.sync_cloud_plugins_after_local_change
        for task in c.background_tasks
    )
    with c.sessions() as db:
        assert len(markers(db, c.user_id)) == 1
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
        assert len(markers(db, c.user_id)) == 1


def test_operation_failure_rolls_back_account_and_intent(local_context):
    c = local_context

    from app.services import plugin_local_sync

    original_commit = plugin_local_sync.Session.commit

    def fail_commit(db):
        if any(
            isinstance(row, Kind) and row.namespace == "plugin-sync"
            for row in db.new | db.dirty
        ):
            raise RuntimeError("operation storage failed")
        return original_commit(db)

    from unittest.mock import patch

    with patch.object(plugin_local_sync.Session, "commit", fail_commit):
        with pytest.raises(RuntimeError, match="operation storage failed"):
            install(c)
    with c.sessions() as db:
        assert len(markers(db, c.user_id)) == 0
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


def test_builtin_install_uses_the_same_atomic_local_path(local_context):
    c = local_context
    response = c.client.post(
        "/plugins/builtin/write-regression-legacy/ensure-installed",
        params=query("builtin:1"),
        json={},
    )
    assert response.status_code == 200, response.text
    assert response.headers["X-Plugin-Delivery-Mode"] == "local_pull_v1"
    assert c.remote_calls == []
    assert c.background_tasks
    with c.sessions() as db:
        assert next(iter(markers(db, c.user_id).values()))["action"] == "ensure_builtin"


def seed_cloud_device(context, device_id="write-regression-device"):
    with context.sessions.begin() as db:
        db.add(
            Kind(
                user_id=context.user_id,
                kind="Device",
                namespace="default",
                name=device_id,
                json={"spec": {"deviceId": device_id, "runtimeInstanceId": device_id}},
            )
        )


def test_unregistered_origin_reuses_existing_socket_dispatch(local_context):
    c = local_context
    seed_cloud_device(c)
    response = c.client.post(
        f"/plugins/marketplace/{c.plugin_id}/install",
        params={**query("unregistered-origin"), "source_device_id": "not-registered"},
    )
    assert response.status_code == 200
    assert c.remote_calls == []
    c.run_background()
    assert c.remote_calls == ["background-plugin"]
    installed = int(response.json()["plugin"]["metadata"]["labels"]["id"])
    assert c.targeted_calls == [installed]


def test_background_replay_reads_latest_removal_instead_of_old_install(
    local_context, monkeypatch
):
    from unittest.mock import AsyncMock

    c = local_context
    monkeypatch.setattr(
        plugin_device_sync.device_capability_sync_service,
        "supports_plugin_delta",
        AsyncMock(return_value=False),
    )
    seed_cloud_device(c)
    initial = install(c)
    installed = int(initial.json()["plugin"]["metadata"]["labels"]["id"])
    removed = c.client.delete(
        f"/plugins/installed/{installed}", params=query("remove", 2)
    )
    assert removed.status_code == 204
    c.run_background()
    assert c.account() is None
    assert "background-plugin" in c.remote_calls or "recovery" in c.remote_calls


def test_cloud_failure_does_not_rollback_local_acceptance(local_context, monkeypatch):
    from unittest.mock import AsyncMock

    c = local_context
    seed_cloud_device(c)
    failure = AsyncMock(side_effect=RuntimeError("remote unavailable"))
    monkeypatch.setattr(
        plugin_device_sync.plugin_device_installation_service,
        "ensure_pending_for_all_devices",
        failure,
    )
    accepted = install(c)
    assert accepted.status_code == 200
    c.run_background()
    failure.assert_awaited_once()
    assert install(c).json() == accepted.json()
    with c.sessions() as db:
        saved = next(iter(markers(db, c.user_id).values()))
        assert saved["operationId"] == "install:1"


@pytest.mark.asyncio
async def test_cloud_sync_wait_does_not_block_a_new_local_intent(
    local_context, monkeypatch
):
    import asyncio

    c = local_context
    seed_cloud_device(c)
    accepted = install(c)
    installed = int(accepted.json()["plugin"]["metadata"]["labels"]["id"])
    started = asyncio.Event()
    release = asyncio.Event()

    async def wait_for_cloud(*args, **kwargs):
        started.set()
        await release.wait()

    monkeypatch.setattr(
        plugin_device_sync.plugin_device_installation_service,
        "ensure_pending_for_all_devices",
        wait_for_cloud,
    )
    background = asyncio.create_task(c.background_tasks.pop(0)())
    try:
        await asyncio.wait_for(started.wait(), timeout=2)
        updated = c.client.put(
            f"/plugins/installed/{installed}",
            params=query("next-local-intent", 2),
            json={"enabled": False},
        )
        assert updated.status_code == 200
        assert not background.done()
        assert c.account().json["spec"]["enabled"] is False
    finally:
        release.set()
        await background


def test_rollback_allows_only_already_accepted_replay(local_context, monkeypatch):
    c = local_context
    accepted = install(c)
    assert accepted.status_code == 200
    monkeypatch.setenv("PLUGIN_LOCAL_SYNC_ENABLED", "false")
    assert install(c).json() == accepted.json()
    assert install(c, "new-operation").status_code == 409
    with c.sessions() as db:
        assert len(markers(db, c.user_id)) == 1


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
        state = (
            db.query(Kind)
            .filter_by(
                user_id=c.user_id,
                kind="PluginSyncState",
                namespace="plugin-sync",
                name="account",
            )
            .one()
        )
        from copy import deepcopy

        document = deepcopy(state.json)
        document["spec"].pop("localIntents")
        state.json = document
    late = c.client.delete(url, params=query("old:remove", 1))
    assert late.status_code == 409 and late.json()["detail"] == "INTENT_SUPERSEDED"
    assert c.account().json["spec"]["releaseId"] == c.upgraded_release_id
    assert c.remote_calls == []


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
    assert replay.status_code == 409
    assert replay.headers["X-Plugin-Operation-State"] == "superseded"
    assert replay.headers["X-Plugin-Intent-Order"] == "1"
    assert c.account().json["spec"]["releaseId"] == c.upgraded_release_id
    conflict = c.client.post(
        f"/plugins/marketplace/{c.plugin_id}/install", params=query("new:update", 3)
    )
    assert conflict.status_code == 409
    assert conflict.json()["detail"] == "IDEMPOTENCY_CONFLICT"


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
        assert len(markers(db, c.user_id)) == 0


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
        assert len(markers(db, c.user_id)) == 1


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


def test_latest_marker_is_bounded_and_legacy_change_fences_lost_response(local_context):
    c = local_context
    accepted = install(c)
    installed = int(accepted.json()["plugin"]["metadata"]["labels"]["id"])
    for order in range(2, 12):
        result = c.client.put(
            f"/plugins/installed/{installed}",
            params=query(f"update:{order}", order),
            json={"enabled": bool(order % 2)},
        )
        assert result.status_code == 200
    with c.sessions() as db:
        slots = markers(db, c.user_id)
        assert len(slots) == 1
        assert slots[str(installed)]["operationId"] == "update:11"
        assert "plugin" not in slots[str(installed)]
    legacy = c.client.put(f"/plugins/installed/{installed}", json={"enabled": False})
    assert legacy.status_code == 200
    replay = c.client.put(
        f"/plugins/installed/{installed}",
        params=query("update:11", 11),
        json={"enabled": True},
    )
    assert replay.status_code == 409
    assert replay.headers["X-Plugin-Operation-State"] == "superseded"
    assert c.account().json["spec"]["enabled"] is False
    # Even after compaction, an old install must not undo an uninstall.
    assert (
        c.client.delete(
            f"/plugins/installed/{installed}", params=query("remove:12", 12)
        ).status_code
        == 204
    )
    stale = install(c)
    assert stale.status_code == 409
    assert stale.headers["X-Plugin-Operation-State"] == "superseded"
    assert c.account() is None


def test_disabled_rollout_still_confirms_compacted_request_supersession(
    local_context, monkeypatch
):
    c = local_context
    installed = int(install(c).json()["plugin"]["metadata"]["labels"]["id"])
    assert (
        c.client.delete(
            f"/plugins/installed/{installed}", params=query("new:remove", 3)
        ).status_code
        == 204
    )
    monkeypatch.setenv("PLUGIN_LOCAL_SYNC_ENABLED", "false")
    late = install(c)
    assert late.status_code == 409
    assert late.headers["X-Plugin-Operation-State"] == "superseded"
    assert c.account() is None


def test_compacted_acceptance_cannot_be_reported_as_unaccepted(
    local_context, monkeypatch
):
    c = local_context
    initial = install(c)
    installed = int(initial.json()["plugin"]["metadata"]["labels"]["id"])
    assert (
        c.client.put(
            f"/plugins/installed/{installed}",
            params=query("new:update", 2),
            json={"enabled": False},
        ).status_code
        == 200
    )

    def fail(*args, **kwargs):
        raise HTTPException(403, "Catalog temporarily inaccessible")

    monkeypatch.setattr(
        plugin_marketplace_service, "reconcile_stale_installed_catalog_refs", fail
    )
    replay = install(c)
    assert replay.status_code == 403
    assert "X-Plugin-Operation-State" not in replay.headers
    assert c.account().json["spec"]["enabled"] is False
