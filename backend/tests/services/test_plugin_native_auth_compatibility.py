"""Legacy device services preserve, but never authorize, native-key grants."""

from copy import deepcopy

import pytest

from app.services.plugin_account_connections import PluginAccountAuthError
from tests.services import test_plugin_account_connections as fixtures
from tests.services.test_plugin_auth_local_lifecycle import (
    call,
    lifecycle,
    local,
)

service = fixtures.service
installed = fixtures.installed
device = fixtures.device


@pytest.mark.parametrize("action", ["login", "logout"])
def test_legacy_lifecycle_preserves_or_invalidates_native_login_generations(
    lifecycle, local, installed, test_db, test_user, action
):
    from app.models.kind import Kind

    call(lifecycle, test_db, test_user, installed, "login")
    row = (
        test_db.query(Kind)
        .filter_by(
            user_id=test_user.id,
            namespace="plugin-auth",
            kind="ConnectorLocalAuthPolicy",
        )
        .one()
    )
    # Legacy-only rows retain the released representation.
    assert set(row.json["spec"]) == {"enabled", "pendingLogins"}
    native = {"desktop-a": "login-a", "desktop-b": "login-b"}
    document = deepcopy(row.json)
    document["spec"].update(pendingNativeLogins=native, revision=7)
    row.json = document
    test_db.flush()

    call(lifecycle, test_db, test_user, installed, action)

    assert row.json["spec"]["pendingNativeLogins"] == (
        native if action == "login" else {}
    )
    assert row.json["spec"]["revision"] == 8
    if action == "logout":
        call(lifecycle, test_db, test_user, installed, "login")
        assert row.json["spec"]["pendingNativeLogins"] == {}


def test_legacy_enrollment_preserves_native_grants_and_logout_revokes_them(
    service, installed, device, test_db, test_user
):
    first = fixtures.enroll(service, test_db, test_user, installed)
    row = service._get(test_db, test_user.id, first.id)
    assert "localGrants" not in row.json["spec"]
    document = deepcopy(row.json)
    document["spec"].update(
        localGrants={"desktop-key": True},
        nativeAuthSources={"desktop-key": {"keyId": "test", "digest": "observation"}},
    )
    row.json = document
    test_db.flush()

    updated = fixtures.enroll(
        service, test_db, test_user, installed, expected_revision=first.revision
    )
    assert row.json["spec"]["localGrants"] == {"desktop-key": True}
    assert (
        row.json["spec"]["nativeAuthSources"] == document["spec"]["nativeAuthSources"]
    )
    # A native-key grant cannot satisfy the original Device permission check.
    with pytest.raises(PluginAccountAuthError, match="plugin_auth_device_not_granted"):
        service.read_for_device(
            test_db,
            user_id=test_user.id,
            connection_id=first.id,
            device_id=device.name,
            installed_plugin_id=installed.id,
            expected_revision=updated.revision,
        )
    service.disconnect(
        test_db,
        user_id=test_user.id,
        connection_id=first.id,
        expected_revision=updated.revision,
    )
    assert row.json["spec"]["localGrants"] == {}
    assert row.json["spec"]["credential"] is None


def test_changed_auth_definition_does_not_keep_native_authorization(
    service, installed, test_db, test_user
):
    first = fixtures.enroll(service, test_db, test_user, installed)
    row = service._get(test_db, test_user.id, first.id)
    row.json = {"spec": {**row.json["spec"], "localGrants": {"desktop-key": True}}}
    changed = deepcopy(installed.json)
    changed["spec"]["components"]["connectors"][0]["accountAuth"][
        "adapter"
    ] = "scripts/new-auth.py"
    installed.json = changed
    test_db.flush()

    fixtures.enroll(
        service, test_db, test_user, installed, expected_revision=first.revision
    )

    assert row.json["spec"]["localGrants"] == {}


migrations = fixtures.migrations


def test_native_migration_cannot_be_consumed_on_legacy_device_route(
    migrations, installed, device, test_db, test_user
):
    fixtures.set_local_device(test_db, device)
    ticket = migrations.create(
        test_db,
        user_id=test_user.id,
        request=fixtures.migration_request(installed, device),
    )
    row = migrations._query(test_db, test_user.id, ticket.id).first()
    spec = deepcopy(row.json["spec"])
    spec["localPrincipal"] = "desktop-key"
    spec.pop("device_id")
    spec.pop("binding")
    row.json = {"spec": spec}
    test_db.flush()
    with pytest.raises(PluginAccountAuthError, match="migration_device_mismatch"):
        migrations.prepare(
            test_db, user_id=test_user.id, device_id=device.name, migration_id=ticket.id
        )
    assert row.is_active


def test_native_transfer_is_not_resumed_or_authorized_by_legacy_device(
    service, installed, device, test_db, test_user
):
    from app.models.kind import Kind
    from app.services.plugin_auth_transfers import PluginAuthTransferService

    fixtures.set_local_device(test_db, device)
    transfer = PluginAuthTransferService(service)
    row = Kind(
        user_id=test_user.id,
        kind="ConnectorTransfer",
        namespace="plugin-auth",
        name="b" * 64,
        is_active=True,
        json={
            "spec": {
                "localPrincipal": "desktop-key",
                "state": "staged",
                "installed_plugin_id": installed.id,
                "connector_slug": "mail",
            }
        },
    )
    test_db.add(row)
    test_db.flush()
    assert (
        transfer.resume(
            test_db,
            user_id=test_user.id,
            request=fixtures.migration_request(installed, device),
        )
        is None
    )
    with pytest.raises(PluginAccountAuthError, match="migration_device_mismatch"):
        transfer.prepare(
            test_db, user_id=test_user.id, device_id=device.name, migration_id=row.name
        )
    assert row.is_active
