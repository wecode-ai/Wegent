"""Relational catalog repair must preserve the retained Kind-backed catalog."""

from copy import deepcopy

from app.models.kind import Kind
from app.services.plugin_marketplace_service import PluginMarketplaceService


def test_catalog_repair_distinguishes_providers_with_identical_catalog_references(
    test_db, test_user
):
    providers = ("wegent-marketplace", "wegent-market", "wework-market", None)
    rows = []
    for index, provider in enumerate(providers):
        source = {
            "type": "marketplace",
            "pluginKey": "catalog-provider-identity",
            "catalogItemId": "999999",
            "marketplace": "wegent",
        }
        if provider is not None:
            source["providerKey"] = provider
        row = Kind(
            user_id=test_user.id,
            kind="InstalledPlugin",
            namespace="default",
            name=f"catalog-provider-{index}",
            json={"spec": {"source": source, "enabled": True}},
            is_active=True,
        )
        test_db.add(row)
        rows.append(row)
    test_db.commit()
    retained_payload = deepcopy(rows[0].json)

    changed = PluginMarketplaceService().reconcile_stale_installed_catalog_refs(
        test_db, user_id=test_user.id
    )

    assert changed == 3
    for row in rows:
        test_db.refresh(row)
    assert rows[0].is_active is True
    assert rows[0].json == retained_payload
    for row in rows[1:]:
        assert row.is_active is False
        assert row.json["spec"]["enabled"] is False
        assert row.json["spec"]["installState"] == "uninstalled"
