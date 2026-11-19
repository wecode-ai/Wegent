"""Builtin recovery must resolve catalog identity before using an intent watermark."""

import pytest
from fastapi import HTTPException

from app.models.kind import Kind
from tests.api.test_plugin_local_sync import local_context, markers, query  # noqa: F401
from tests.api.test_plugin_write_operations import plugin_requests  # noqa: F401


@pytest.mark.parametrize("enabled", [True, False])
def test_personal_plugin_does_not_supersede_same_named_builtin(
    local_context, monkeypatch, enabled
):
    from app.models.plugin_marketplace import Plugin, PluginRelease
    from app.services.plugin_marketplace_identity import (
        catalog_namespace_for_visibility,
    )

    c = local_context
    with c.sessions.begin() as db:
        official = db.get(Plugin, c.plugin_id)
        slug = official.slug
        personal = Plugin(
            catalog_namespace=catalog_namespace_for_visibility(
                "personal", owner_user_id=c.user_id
            ),
            slug=slug,
            name=official.name,
            owner_user_id=c.user_id,
            status="published",
            visibility="personal",
        )
        db.add(personal)
        db.flush()
        release = PluginRelease(
            plugin_id=personal.id,
            version="1.0.0",
            manifest_json={},
            interface_json={},
            storage_key="regression/personal.zip",
            sha256="b" * 64,
            size_bytes=1,
            status="ready",
            scan_status="passed",
            scan_report_json={"components": {}},
        )
        db.add(release)
        db.flush()
        personal.latest_release_id = release.id
        personal_id = personal.id
    accepted = c.client.post(
        f"/plugins/marketplace/{personal_id}/install",
        params=query("personal:install", 2),
    )
    assert accepted.status_code == 200, accepted.text
    personal_installed = int(accepted.json()["plugin"]["metadata"]["labels"]["id"])
    monkeypatch.setenv("PLUGIN_LOCAL_SYNC_ENABLED", str(enabled).lower())

    recovered = c.client.post(
        f"/plugins/builtin/{slug}/ensure-installed",
        params=query("original:builtin", 1),
        json={},
    )

    if enabled:
        assert recovered.status_code == 200, recovered.text
        assert recovered.json()["plugin"]["spec"]["pluginId"] == c.plugin_id
        assert recovered.json()["plugin"]["metadata"]["labels"]["id"] != str(
            personal_installed
        )
    else:
        assert recovered.status_code == 409
        assert recovered.json()["detail"] == "LOCAL_SYNC_DISABLED"
        assert "X-Plugin-Operation-State" not in recovered.headers
    with c.sessions() as db:
        personal_row = db.get(Kind, personal_installed)
        assert personal_row.is_active
        assert personal_row.json["spec"]["pluginId"] == personal_id
        assert (
            markers(db, c.user_id)[str(personal_installed)]["operationId"]
            == "personal:install"
        )


@pytest.mark.parametrize("enabled", [True, False])
@pytest.mark.parametrize("successor", ["update", "uninstall"])
def test_builtin_slug_alias_uses_its_own_watermark_after_withdrawal(
    local_context, monkeypatch, enabled, successor
):
    from copy import deepcopy

    from app.models.plugin_marketplace import Plugin

    c = local_context
    with c.sessions.begin() as db:
        plugin = db.get(Plugin, c.plugin_id)
        slug = plugin.slug
        plugin.name = "manifest-alias"
    params = query("original:builtin", 1)
    url = f"/plugins/builtin/{slug}/ensure-installed"
    first = c.client.post(url, params=params, json={})
    assert first.status_code == 200, first.text
    installed = int(first.json()["plugin"]["metadata"]["labels"]["id"])
    if successor == "update":
        newer = c.client.put(
            f"/plugins/installed/{installed}",
            params=query("newer:update", 2),
            json={"releaseId": c.upgraded_release_id},
        )
        assert newer.status_code == 200, newer.text
    else:
        assert (
            c.client.delete(
                f"/plugins/installed/{installed}", params=query("newer:uninstall", 2)
            ).status_code
            == 204
        )
    with c.sessions.begin() as db:
        db.get(Plugin, c.plugin_id).status = "draft"
        row = db.get(Kind, installed)
        expected = (deepcopy(row.json), row.is_active)
        expected_markers = deepcopy(markers(db, c.user_id))
    monkeypatch.setenv("PLUGIN_LOCAL_SYNC_ENABLED", str(enabled).lower())

    replay = c.client.post(url, params=params, json={})

    assert replay.status_code == 409, replay.text
    assert replay.json()["detail"] == "INTENT_SUPERSEDED"
    assert replay.headers["X-Plugin-Operation-State"] == "superseded"
    assert replay.headers["X-Plugin-Operation-Id"] == "original:builtin"
    assert replay.headers["X-Plugin-Intent-Order"] == "1"
    with c.sessions() as db:
        row = db.get(Kind, installed)
        assert (row.json, row.is_active) == expected
        assert markers(db, c.user_id) == expected_markers


@pytest.mark.parametrize("successor", ["update", "uninstall"])
def test_legacy_builtin_keeps_its_identity_when_catalog_is_inactive(
    local_context, successor
):
    from app.services.builtin_plugin_registry import BUILTIN_PLUGIN_OWNER_ID
    from tests.api.test_plugin_write_operations import LEGACY_KEY

    c = local_context
    url = f"/plugins/builtin/{LEGACY_KEY}/ensure-installed"
    params = query("original:legacy-builtin", 1)
    accepted = c.client.post(url, params=params, json={})
    assert accepted.status_code == 200, accepted.text
    installed = int(accepted.json()["plugin"]["metadata"]["labels"]["id"])
    if successor == "update":
        newer = c.client.put(
            f"/plugins/installed/{installed}",
            params=query("newer:legacy", 2),
            json={"enabled": False},
        )
        assert newer.status_code == 200, newer.text
    else:
        assert (
            c.client.delete(
                f"/plugins/installed/{installed}", params=query("newer:legacy", 2)
            ).status_code
            == 204
        )
    with c.sessions.begin() as db:
        catalog = (
            db.query(Kind)
            .filter_by(
                user_id=BUILTIN_PLUGIN_OWNER_ID,
                kind="PluginMarketplaceItem",
                namespace="default",
            )
            .one()
        )
        catalog.is_active = False

    replay = c.client.post(url, params=params, json={})

    assert replay.status_code == 409, replay.text
    assert replay.headers["X-Plugin-Operation-State"] == "superseded"
    assert replay.headers["X-Plugin-Operation-Id"] == "original:legacy-builtin"
    with c.sessions() as db:
        row = db.get(Kind, installed)
        assert row.is_active == (successor == "update")
        assert row.json["spec"]["enabled"] is False


def test_legacy_builtin_does_not_match_a_modern_catalog_id_collision(local_context):
    from app.models.plugin_marketplace import Plugin, PluginRelease
    from app.services.builtin_plugin_registry import BUILTIN_PLUGIN_OWNER_ID
    from app.services.plugin_installation_operations import (
        find_builtin_account_installation,
    )
    from app.services.plugin_marketplace_identity import personal_catalog_namespace
    from tests.api.test_plugin_write_operations import LEGACY_KEY

    c = local_context
    with c.sessions.begin() as db:
        legacy = (
            db.query(Kind)
            .filter_by(
                user_id=BUILTIN_PLUGIN_OWNER_ID,
                kind="PluginMarketplaceItem",
                namespace="default",
            )
            .one()
        )
        # The two independent catalog tables can assign exactly the same ID.
        personal = Plugin(
            id=legacy.id,
            catalog_namespace=personal_catalog_namespace(c.user_id),
            slug=LEGACY_KEY,
            name=LEGACY_KEY,
            owner_user_id=c.user_id,
            status="published",
            visibility="personal",
        )
        db.add(personal)
        db.flush()
        release = PluginRelease(
            plugin_id=personal.id,
            version="1.0.0",
            manifest_json={},
            interface_json={},
            storage_key="regression/collision.zip",
            sha256="c" * 64,
            size_bytes=1,
            status="ready",
            scan_status="passed",
            scan_report_json={"components": {}},
        )
        db.add(release)
        db.flush()
        personal.latest_release_id = release.id
        personal_id = personal.id
    response = c.client.post(
        f"/plugins/marketplace/{personal_id}/install",
        params=query("personal:collision", 2),
    )
    assert response.status_code == 200, response.text
    with c.sessions() as db:
        with pytest.raises(HTTPException) as conflict:
            find_builtin_account_installation(
                db, user_id=c.user_id, plugin_key=LEGACY_KEY
            )
        assert conflict.value.status_code == 409
        assert conflict.value.detail == "plugin_write_conflict"
        assert (
            find_builtin_account_installation(
                db, user_id=c.user_id + 1, plugin_key=LEGACY_KEY
            )
            is None
        )


@pytest.mark.parametrize("enabled", [True, False])
def test_modern_builtin_does_not_borrow_a_legacy_catalog_watermark(
    local_context, monkeypatch, enabled
):
    from app.models.plugin_marketplace import Plugin, PluginRelease
    from app.services.builtin_plugin_registry import BUILTIN_PLUGIN_OWNER_ID
    from app.services.plugin_marketplace_identity import OFFICIAL_CATALOG_NAMESPACE
    from tests.api.test_plugin_write_operations import LEGACY_KEY

    c = local_context
    accepted = c.client.post(
        f"/plugins/builtin/{LEGACY_KEY}/ensure-installed",
        params=query("legacy:install", 2),
        json={},
    )
    assert accepted.status_code == 200, accepted.text
    with c.sessions.begin() as db:
        legacy = (
            db.query(Kind)
            .filter_by(
                user_id=BUILTIN_PLUGIN_OWNER_ID,
                kind="PluginMarketplaceItem",
                namespace="default",
            )
            .one()
        )
        modern = Plugin(
            id=legacy.id,
            catalog_namespace=OFFICIAL_CATALOG_NAMESPACE,
            slug=LEGACY_KEY,
            name=LEGACY_KEY,
            owner_user_id=c.user_id,
            status="published",
            visibility="public",
        )
        db.add(modern)
        db.flush()
        release = PluginRelease(
            plugin_id=modern.id,
            version="2.0.0",
            manifest_json={},
            interface_json={},
            storage_key="regression/modern.zip",
            sha256="d" * 64,
            size_bytes=1,
            status="ready",
            scan_status="passed",
            scan_report_json={"components": {}},
        )
        db.add(release)
        db.flush()
        modern.latest_release_id = release.id
    monkeypatch.setenv("PLUGIN_LOCAL_SYNC_ENABLED", str(enabled).lower())
    replay = c.client.post(
        f"/plugins/builtin/{LEGACY_KEY}/ensure-installed",
        params=query("modern:pending", 1),
        json={},
    )
    assert replay.status_code == 409
    assert replay.json()["detail"] == "plugin_write_conflict"
    assert "X-Plugin-Operation-State" not in replay.headers
