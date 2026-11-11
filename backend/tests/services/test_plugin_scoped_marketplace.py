"""Catalog identity must not broaden a single installation's lease scope."""

from copy import deepcopy

from app.services.plugin_marketplace_service import PluginMarketplaceService
from tests.services.test_plugin_marketplace_v2 import _create_marketplace_update_install


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
