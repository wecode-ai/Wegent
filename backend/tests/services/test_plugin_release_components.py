"""Regression for historical releases whose scan omitted accountAuth."""

import io
import json
import zipfile
from copy import deepcopy

import pytest

from app.models.kind import Kind
from app.models.plugin_marketplace import (
    Plugin,
    PluginDeviceInstallation,
    PluginRelease,
)
from app.services.plugin_account_connections import (
    PluginAccountAuthError,
    PluginAccountConnectionService,
)
from app.services.plugin_marketplace_service import PluginMarketplaceService
from app.services.plugin_package_parser import plugin_package_parser
from app.services.plugin_release_components import components_with_manifest_account_auth

AUTH = {
    "protocolVersion": 1,
    "credentialType": "password",
    "adapter": "scripts/account-auth.py",
}
CONNECTOR = {
    "slug": "gitlab-intra",
    "authPolicy": "on_install",
    "localAuth": {
        "kind": "browser_oauth",
        "health": ["scripts/auth.py", "health"],
        "start": ["scripts/auth.py", "login"],
    },
}


@pytest.fixture
def catalog(test_db):
    plugin = Plugin(
        slug="gitlab-intra",
        name="gitlab-intra",
        display_name="GitLab Intra",
        status="published",
        visibility="workspace",
        keywords_json=[],
        interface_json={},
    )
    test_db.add(plugin)
    test_db.flush()

    def release(version="0.5.0", account_auth=True, scan_report=None):
        connector = deepcopy(CONNECTOR)
        if account_auth:
            connector["accountAuth"] = AUTH
        row = PluginRelease(
            plugin_id=plugin.id,
            version=version,
            manifest_json={
                "name": plugin.name,
                "version": version,
                "connectors": [connector],
            },
            scan_report_json=(
                scan_report
                if scan_report is not None
                else {"components": {"connectors": [deepcopy(CONNECTOR)], "skills": []}}
            ),
            interface_json={},
            storage_key=f"plugins/{version}.zip",
            sha256="a" * 64,
            size_bytes=100,
            status="ready",
            scan_status="passed",
        )
        test_db.add(row)
        test_db.flush()
        plugin.latest_release_id = row.id
        return row

    return plugin, release


def legacy_install(db, user, plugin, release):
    payload = PluginMarketplaceService()._installed_payload(plugin, release)
    payload["spec"]["components"] = deepcopy(release.scan_report_json["components"])
    payload["spec"]["updatePolicy"] = "manual"
    payload["spec"]["componentStates"] = {"skill:review": False}
    row = Kind(
        user_id=user.id,
        kind="InstalledPlugin",
        namespace="default",
        name=payload["metadata"]["name"],
        json=payload,
        is_active=True,
    )
    db.add(row)
    db.flush()
    return row


def test_install_uses_manifest_auth_without_mutating_published_snapshot(
    catalog, test_db, test_user
):
    plugin, publish = catalog
    release = publish()
    original = deepcopy(release.scan_report_json)

    installed = PluginMarketplaceService().install(
        test_db, user_id=test_user.id, plugin_id=plugin.id
    )

    assert installed.spec.components.connectors[0].accountAuth.model_dump() == AUTH
    test_db.refresh(release)
    assert release.scan_report_json == original


def test_update_uses_target_manifest_auth(catalog, test_db, test_user):
    plugin, publish = catalog
    old = publish("0.4.0", account_auth=False)
    installed = legacy_install(test_db, test_user, plugin, old)
    target = publish()
    test_db.commit()

    updated = PluginMarketplaceService().update_release(
        test_db,
        user_id=test_user.id,
        installed_id=installed.id,
        release_id=target.id,
    )

    assert updated.spec.components.connectors[0].accountAuth.model_dump() == AUTH
    assert updated.spec.updatePolicy == "manual"
    assert updated.spec.componentStates == {"skill:review": False}


def test_same_release_repair_restores_auth_and_preserves_device_state(
    catalog, test_db, test_user
):
    plugin, publish = catalog
    release = publish()
    installed = legacy_install(test_db, test_user, plugin, release)
    device = PluginDeviceInstallation(
        user_id=test_user.id,
        installed_kind_id=installed.id,
        device_id="app-record-test",
        desired_release_id=release.id,
        actual_release_id=release.id,
        state="failed",
        attempt_count=3,
        error_code="PLUGIN_SYNC_FAILED",
    )
    test_db.add(device)
    test_db.commit()
    service = PluginMarketplaceService()
    with pytest.raises(PluginAccountAuthError, match="plugin_auth_not_supported"):
        PluginAccountConnectionService._plugin(
            test_db, test_user.id, installed.id, "gitlab-intra"
        )

    assert (
        service.reconcile_stale_installed_catalog_refs(test_db, user_id=test_user.id)
        == 1
    )

    _, definition = PluginAccountConnectionService._plugin(
        test_db, test_user.id, installed.id, "gitlab-intra"
    )
    assert definition.model_dump() == AUTH
    assert installed.json["spec"]["revision"] == 2
    assert installed.json["spec"]["updatePolicy"] == "manual"
    assert installed.json["spec"]["componentStates"] == {"skill:review": False}
    test_db.refresh(device)
    assert (device.state, device.attempt_count, device.actual_release_id) == (
        "failed",
        3,
        release.id,
    )
    assert (
        service.reconcile_stale_installed_catalog_refs(test_db, user_id=test_user.id)
        == 0
    )
    assert installed.json["spec"]["revision"] == 2


def test_repair_uses_pinned_release_even_when_latest_removes_auth(
    catalog, test_db, test_user
):
    plugin, publish = catalog
    pinned = publish()
    installed = legacy_install(test_db, test_user, plugin, pinned)
    publish("0.6.0", account_auth=False)
    test_db.commit()

    PluginMarketplaceService().reconcile_stale_installed_catalog_refs(
        test_db, user_id=test_user.id
    )

    assert installed.json["spec"]["releaseId"] == pinned.id
    assert installed.json["spec"]["components"]["connectors"][0]["accountAuth"] == AUTH


@pytest.mark.parametrize(
    "field,value", [("version", "0.4.0"), ("checksum", "sha256:wrong")]
)
def test_same_release_repair_does_not_rebind_mismatched_package(
    catalog, test_db, test_user, field, value
):
    plugin, publish = catalog
    release = publish()
    installed = legacy_install(test_db, test_user, plugin, release)
    payload = deepcopy(installed.json)
    if field == "checksum":
        payload["spec"]["packageRef"][field] = value
    else:
        payload["spec"][field] = value
    installed.json = payload
    test_db.commit()

    assert (
        PluginMarketplaceService().reconcile_stale_installed_catalog_refs(
            test_db, user_id=test_user.id
        )
        == 0
    )
    assert installed.json == payload


def test_manifest_removal_cannot_resurrect_auth_from_scanned_components():
    components = {"connectors": [{**CONNECTOR, "accountAuth": AUTH}]}
    for manifest in ({}, {"connectors": [CONNECTOR]}, {"connectors": []}):
        corrected = components_with_manifest_account_auth(components, manifest)
        assert "accountAuth" not in corrected["connectors"][0]
        assert components["connectors"][0]["accountAuth"] == AUTH


def test_repair_preserves_disabled_plugin_and_auth_rejection(
    catalog, test_db, test_user
):
    plugin, publish = catalog
    release = publish()
    installed = legacy_install(test_db, test_user, plugin, release)
    payload = deepcopy(installed.json)
    payload["spec"]["enabled"] = False
    installed.json = payload
    test_db.commit()

    assert (
        PluginMarketplaceService().reconcile_stale_installed_catalog_refs(
            test_db, user_id=test_user.id
        )
        == 1
    )

    assert installed.json["spec"]["enabled"] is False
    with pytest.raises(PluginAccountAuthError, match="plugin_auth_plugin_disabled"):
        PluginAccountConnectionService._plugin(
            test_db, test_user.id, installed.id, "gitlab-intra"
        )


def test_repair_removes_stale_auth_when_current_manifest_removes_it(
    catalog, test_db, test_user
):
    plugin, publish = catalog
    release = publish(account_auth=False)
    installed = legacy_install(test_db, test_user, plugin, release)
    payload = deepcopy(installed.json)
    payload["spec"]["components"]["connectors"][0]["accountAuth"] = AUTH
    installed.json = payload
    test_db.commit()

    assert (
        PluginMarketplaceService().reconcile_stale_installed_catalog_refs(
            test_db, user_id=test_user.id
        )
        == 1
    )

    with pytest.raises(PluginAccountAuthError, match="plugin_auth_not_supported"):
        PluginAccountConnectionService._plugin(
            test_db, test_user.id, installed.id, "gitlab-intra"
        )


@pytest.mark.parametrize("connectors", [None, {}, "invalid", 1])
def test_non_list_manifest_connectors_clear_auth_without_losing_components(connectors):
    components = {"connectors": [{**CONNECTOR, "accountAuth": AUTH}], "skills": []}

    corrected = components_with_manifest_account_auth(
        components, {"connectors": connectors}
    )

    assert corrected == {"connectors": [CONNECTOR], "skills": []}
    assert components["connectors"][0]["accountAuth"] == AUTH


@pytest.mark.parametrize("with_auth", [False, True])
def test_manifest_auth_uses_the_package_validated_declaration(with_auth):
    first = {**CONNECTOR, "slug": " gitlab-intra "}
    if with_auth:
        first["accountAuth"] = AUTH
    manifest = {
        "name": "gitlab-intra",
        "version": "0.5.0",
        "connectors": [
            {"slug": "gitlab-intra", "authPolicy": "invalid"},
            first,
            {
                "slug": "gitlab-intra",
                "accountAuth": {**AUTH, "adapter": "../unchecked.py"},
            },
        ],
    }
    package = io.BytesIO()
    with zipfile.ZipFile(package, "w") as archive:
        archive.writestr(".codex-plugin/plugin.json", json.dumps(manifest))
        archive.writestr(AUTH["adapter"], "# Validated adapter")
    parsed = plugin_package_parser.parse_package(package.getvalue())
    assert len(parsed.components.connectors) == 1

    corrected = components_with_manifest_account_auth(
        {"connectors": [deepcopy(CONNECTOR)]}, parsed.manifest
    )

    declaration = parsed.components.connectors[0].accountAuth
    assert corrected["connectors"][0].get("accountAuth") == (
        declaration.model_dump(exclude_none=True) if declaration else None
    )


@pytest.mark.parametrize("scan_report", [{}, {"components": None}, {"components": {}}])
@pytest.mark.parametrize("with_auth", [False, True])
def test_catalog_remap_preserves_components_when_target_scan_has_none(
    catalog, test_db, test_user, scan_report, with_auth
):
    plugin, publish = catalog
    old = publish("0.4.0")
    installed = legacy_install(test_db, test_user, plugin, old)
    target = publish(scan_report=scan_report, account_auth=with_auth)
    payload = deepcopy(installed.json)
    payload["spec"]["releaseId"] = target.id
    payload["spec"]["source"]["catalogItemId"] = "stale"
    original = {
        "connectors": [{**CONNECTOR, "accountAuth": AUTH}],
        "skills": [{"name": "review", "path": "skills/review/SKILL.md"}],
    }
    payload["spec"]["components"] = original
    installed.json = payload
    test_db.commit()

    changed = PluginMarketplaceService().reconcile_stale_installed_catalog_refs(
        test_db, user_id=test_user.id
    )

    assert changed == 1
    components = installed.json["spec"]["components"]
    assert components["skills"] == original["skills"]
    assert components["connectors"][0]["localAuth"] == CONNECTOR["localAuth"]
    assert components["connectors"][0].get("accountAuth") == (
        AUTH if with_auth else None
    )
    assert installed.json["spec"]["componentStates"] == {"skill:review": False}
    assert installed.json["spec"]["updatePolicy"] == "manual"
    test_db.refresh(target)
    assert target.scan_report_json == scan_report
