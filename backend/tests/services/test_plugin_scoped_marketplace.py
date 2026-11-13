"""Catalog identity must not broaden a single installation's lease scope."""

from copy import deepcopy

import pytest
from sqlalchemy import event

from app.models.kind import Kind
from app.models.plugin_state import PluginState
from app.services.device.plugin_sync_protocol import lock_installed_plugin_state
from app.services.installed_plugin_service import installed_plugin_service
from app.services.plugin_local_sync import mutate_local_plugin
from app.services.plugin_marketplace_service import PluginMarketplaceService
from app.services.plugin_write_errors import PluginWriteError
from app.services.plugin_write_identity import acquire_installation_write_lock
from tests.services.test_plugin_marketplace_v2 import _create_marketplace_update_install


@pytest.mark.parametrize("entry", ["marketplace", "local_install", "local_builtin"])
@pytest.mark.parametrize("active", [True, False])
def test_existing_legacy_name_reuses_one_bound_state(
    test_db, test_user, plugin_write_backend, monkeypatch, entry, active
):
    service = PluginMarketplaceService()
    installed, plugin, _, _ = _create_marketplace_update_install(
        test_db, user_id=test_user.id, index=806
    )
    installed.name = installed_plugin_service._safe_kind_name(plugin.slug)
    installed.is_active = active
    test_db.commit()
    original_id, original_name = installed.id, installed.name
    state = lock_installed_plugin_state(test_db, test_user.id, installed.id)
    state.json = {
        **state.json,
        "spec": {
            **state.json["spec"],
            "generation": 41,
            "devices": {"peer": {"plugins": {str(installed.id): 40}}},
            "localIntentOrders": {"peer": {str(installed.id): 9}},
        },
    }
    test_db.commit()
    original_state_id = state.id
    monkeypatch.setenv("PLUGIN_LOCAL_SYNC_ENABLED", "true")
    if entry == "marketplace":
        result = service.install(test_db, user_id=test_user.id, plugin_id=plugin.id)
        result_id = int(result.metadata["labels"]["id"])
    else:
        result = mutate_local_plugin(
            test_db,
            user_id=test_user.id,
            instance_id="legacy-name-client",
            operation_id="legacy-name-install",
            intent_order=1,
            action="ensure_builtin" if entry == "local_builtin" else "install",
            target_id=plugin.slug if entry == "local_builtin" else plugin.id,
        )
        result_id = int(result["metadata"]["labels"]["id"])
    assert result_id == original_id
    test_db.refresh(installed)
    assert installed.name == original_name and installed.is_active
    states = test_db.query(PluginState).filter_by(user_id=test_user.id).all()
    assert [(row.id, row.plugin_key, row.installed_kind_id) for row in states] == [
        (original_state_id, original_name, original_id)
    ]
    assert states[0].json["spec"]["generation"] == 41
    assert states[0].json["spec"]["devices"] == {
        "peer": {"plugins": {str(original_id): 40}}
    }
    assert states[0].json["spec"]["localIntentOrders"]["peer"] == {str(original_id): 9}
    assert (
        test_db.query(Kind)
        .filter_by(user_id=test_user.id, kind="InstalledPlugin", namespace="default")
        .count()
        == 1
    )


def test_existing_install_ignores_an_unrelated_busy_derived_name(
    test_db, test_user, plugin_write_backend, monkeypatch
):
    service = PluginMarketplaceService()
    installed, plugin, _, _ = _create_marketplace_update_install(
        test_db, user_id=test_user.id, index=807
    )
    installed.name = installed_plugin_service._safe_kind_name(plugin.slug)
    test_db.commit()
    derived_name = service._kind_name(plugin.catalog_namespace, plugin.slug)
    placeholder = PluginState(
        user_id=test_user.id,
        plugin_key=derived_name,
        installed_kind_id=0,
        json={"spec": {"revision": 3, "generation": 17}},
    )
    test_db.add(placeholder)
    test_db.commit()
    key = f"wegent:plugin-write:{test_user.id}:{service._kind_name(plugin.catalog_namespace, plugin.slug)}"
    held = plugin_write_backend.lock(
        key, timeout=30, blocking_timeout=0, thread_local=False
    )
    assert held.acquire()
    monkeypatch.setattr("app.services.plugin_write_coordination.WAIT_SECONDS", 0)
    try:
        result = service.install(test_db, user_id=test_user.id, plugin_id=plugin.id)
        assert int(result.metadata["labels"]["id"]) == installed.id
        assert held.owned()
        assert set(plugin_write_backend.values) == {key}
        test_db.refresh(placeholder)
        assert placeholder.installed_kind_id == 0
        assert placeholder.json == {"spec": {"revision": 3, "generation": 17}}
    finally:
        held.release()


@pytest.mark.parametrize("initially_found", [True, False])
def test_installation_identity_is_rechecked_after_lease_acquisition(
    test_db, test_user, plugin_write_backend, initially_found
):
    first, _, _, _ = _create_marketplace_update_install(
        test_db, user_id=test_user.id, index=808
    )
    second, _, _, _ = _create_marketplace_update_install(
        test_db, user_id=test_user.id, index=809
    )
    test_db.commit()
    original = [deepcopy(row.json) for row in (first, second)]
    found = iter([first if initially_found else None, second])
    with pytest.raises(PluginWriteError, match="plugin_write_conflict"):
        acquire_installation_write_lock(
            test_db,
            test_user.id,
            creation_name="new-install-identity",
            find_existing=lambda: next(found),
        )
    assert (test_user.id, second.name) not in test_db.info["plugin_write_leases"]
    test_db.rollback()
    assert [row.json for row in (first, second)] == original


def test_same_slug_in_different_catalogs_does_not_lock_another_installation(
    test_db,
    test_user,
    plugin_write_backend,
    monkeypatch,
):
    service = PluginMarketplaceService()
    first, first_catalog, _, _ = _create_marketplace_update_install(
        test_db,
        user_id=test_user.id,
        index=801,
    )
    second, second_catalog, current, _ = _create_marketplace_update_install(
        test_db,
        user_id=test_user.id,
        index=802,
    )
    second_catalog.catalog_namespace = "public"
    second_catalog.visibility = "public"
    second_catalog.slug = first_catalog.slug
    second_catalog.name = first_catalog.name
    second.json = service._installed_payload(second_catalog, current)
    second.name = service._kind_name(
        second_catalog.catalog_namespace, second_catalog.slug
    )
    test_db.commit()
    preserved = deepcopy(first.json)
    held_key = f"wegent:plugin-write:{test_user.id}:{first.name}"
    held = plugin_write_backend.lock(
        held_key, timeout=30, blocking_timeout=0, thread_local=False
    )
    assert held.acquire()
    monkeypatch.setattr("app.services.plugin_write_coordination.WAIT_SECONDS", 0.05)
    try:
        installed = service.install(
            test_db, user_id=test_user.id, plugin_id=second_catalog.id
        )
        assert int(installed.metadata["labels"]["id"]) == second.id
        test_db.refresh(first)
        assert first.json == preserved
        assert held.owned()
        assert set(plugin_write_backend.values) == {held_key}
    finally:
        held.release()


def test_canonical_reactivation_preserves_plugin_scope_without_row_locks(
    test_db, test_user, plugin_write_backend, monkeypatch
):
    service = PluginMarketplaceService()
    other, _, _, _ = _create_marketplace_update_install(
        test_db, user_id=test_user.id, index=804
    )
    stale, plugin, release, _ = _create_marketplace_update_install(
        test_db, user_id=test_user.id, index=805
    )
    original_id = stale.id
    payload = service._installed_payload(plugin, release)
    payload["spec"]["pluginId"] = plugin.id + 1000
    payload["spec"]["source"]["catalogItemId"] = str(plugin.id + 1000)
    stale.name = service._kind_name(plugin.catalog_namespace, plugin.slug)
    stale.json = payload
    stale.is_active = False
    test_db.commit()
    held_key = f"wegent:plugin-write:{test_user.id}:{other.name}"
    held = plugin_write_backend.lock(
        held_key, timeout=30, blocking_timeout=0, thread_local=False
    )
    assert held.acquire()
    monkeypatch.setattr("app.services.plugin_write_coordination.WAIT_SECONDS", 0.05)

    def reject_row_lock(context):
        assert getattr(context.statement, "_for_update_arg", None) is None

    event.listen(test_db, "do_orm_execute", reject_row_lock)
    try:
        result = service.install(test_db, user_id=test_user.id, plugin_id=plugin.id)
        assert int(result.metadata["labels"]["id"]) == original_id
        test_db.refresh(stale)
        assert stale.is_active
        assert stale.json["spec"]["pluginId"] == plugin.id
        assert stale.json["spec"]["writeRevision"] > 0
        assert held.owned()
        assert set(plugin_write_backend.values) == {held_key}
    finally:
        event.remove(test_db, "do_orm_execute", reject_row_lock)
        held.release()


def test_healthy_inventory_reads_do_not_wait_for_authentication_writes(
    test_db,
    test_user,
    plugin_write_backend,
    monkeypatch,
):
    service = PluginMarketplaceService()
    installed, plugin, current, _ = _create_marketplace_update_install(
        test_db,
        user_id=test_user.id,
        index=803,
    )
    installed.json = service._installed_payload(plugin, current)
    test_db.commit()
    preserved = deepcopy(installed.json)
    held_key = f"wegent:plugin-write:{test_user.id}:{installed.name}"
    held = plugin_write_backend.lock(
        held_key, timeout=30, blocking_timeout=0, thread_local=False
    )
    assert held.acquire()
    monkeypatch.setattr("app.services.plugin_write_coordination.WAIT_SECONDS", 0.05)
    try:
        assert (
            service.reconcile_stale_installed_catalog_refs(
                test_db, user_id=test_user.id
            )
            == 0
        )
        assert installed.json == preserved
        assert not test_db.info.get("plugin_write_leases")
        assert held.owned()
    finally:
        held.release()
