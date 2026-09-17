"""Exclusive OAuth escrow never becomes business authentication before detach."""

import json
from copy import deepcopy
from unittest.mock import patch

import pytest
from pydantic import SecretStr

from app.schemas.plugin_account_auth import PluginNativeEnrollment
from app.services.plugin_account_connections import PluginAccountAuthError
from app.services.plugin_auth_transfers import PluginAuthTransferService
from app.services.plugin_credential_cipher import PluginCredentialCipherError
from tests.services import test_plugin_account_connections as fixtures

device = fixtures.device
installed = fixtures.installed
service = fixtures.service
migrations = fixtures.migrations


@pytest.fixture
def transfer(test_db, test_user, device, installed, service, migrations):
    value = deepcopy(installed.json)
    value["spec"]["packageRef"] = {"checksum": "sha256:" + "a" * 64}
    definition = value["spec"]["components"]["connectors"][0]["accountAuth"]
    definition.update(
        credentialType="oauth2", oauth2=["refresh", "revoke"], exportMode="exclusive"
    )
    installed.json = value
    fixtures.set_local_device(test_db, device)
    ticket = migrations.create(
        test_db,
        user_id=test_user.id,
        request=fixtures.migration_request(installed, device),
    )
    request = PluginNativeEnrollment(
        migration_id=ticket.id,
        account_id="synthetic-account",
        credential=SecretStr(
            '{"access_token":"synthetic-access","refresh_token":"synthetic-refresh"}'
        ),
    )
    return PluginAuthTransferService(service), request


def stage(transfer, db, user, device):
    service, request = transfer
    return service.stage(db, user_id=user.id, device_id=device.name, request=request)


def prepare(transfer, db, user, device):
    service, request = transfer
    return service.prepare(
        db, user_id=user.id, device_id=device.name, migration_id=request.migration_id
    )


def finish(transfer, db, user, device):
    service, request = transfer
    return service.finish(
        db, user_id=user.id, device_id=device.name, migration_id=request.migration_id
    )


def abort(transfer, db, user, device):
    service, request = transfer
    return service.abort(
        db, user_id=user.id, device_id=device.name, migration_id=request.migration_id
    )


def test_source_change_clears_escrow_and_allows_a_fresh_migration(
    transfer, service, migrations, installed, test_db, test_user, device
):
    stage(transfer, test_db, test_user, device)
    assert abort(transfer, test_db, test_user, device) == {"state": "aborted"}
    assert abort(transfer, test_db, test_user, device) == {"state": "aborted"}
    row = transfer[0]._get(test_db, test_user.id, transfer[1].migration_id)
    assert not row.is_active
    assert "credential" not in row.json["spec"]
    assert service.list_connections(test_db, user_id=test_user.id) == []
    for operation in (stage, prepare, finish):
        with pytest.raises(PluginAccountAuthError, match="source_changed"):
            operation(transfer, test_db, test_user, device)
    fresh = migrations.create(
        test_db,
        user_id=test_user.id,
        request=fixtures.migration_request(installed, device),
    )
    assert fresh.id != transfer[1].migration_id
    renewed = (transfer[0], transfer[1].model_copy(update={"migration_id": fresh.id}))
    assert stage(renewed, test_db, test_user, device) == {"state": "staged"}
    assert finish(renewed, test_db, test_user, device).status == "connected"


def test_completed_transfer_cannot_be_aborted(transfer, test_db, test_user, device):
    stage(transfer, test_db, test_user, device)
    connected = finish(transfer, test_db, test_user, device)
    with pytest.raises(PluginAccountAuthError, match="transfer_completed"):
        abort(transfer, test_db, test_user, device)
    assert finish(transfer, test_db, test_user, device) == connected


def test_source_abort_requires_the_bound_runtime(transfer, test_db, test_user, device):
    stage(transfer, test_db, test_user, device)
    original = transfer[0].connections._device_binding

    def changed_binding(*args):
        logical, binding = original(*args)
        return logical, {**binding, "runtimeInstanceId": "replacement"}

    with patch.object(
        transfer[0].connections, "_device_binding", side_effect=changed_binding
    ):
        with pytest.raises(PluginAccountAuthError, match="device_mismatch"):
            abort(transfer, test_db, test_user, device)
    assert prepare(transfer, test_db, test_user, device)["state"] == "staged"


def test_stage_is_encrypted_and_has_no_connection_or_grant(
    transfer, service, test_db, test_user, device
):
    assert stage(transfer, test_db, test_user, device) == {"state": "staged"}
    assert service.list_connections(test_db, user_id=test_user.id) == []
    escrow = transfer[0]._get(test_db, test_user.id, transfer[1].migration_id)
    assert "synthetic-refresh" not in json.dumps(escrow.json)
    assert prepare(transfer, test_db, test_user, device)["credential"] == (
        transfer[1].credential.get_secret_value()
    )


def test_exclusive_credentials_cannot_bypass_staging(
    transfer, migrations, test_db, test_user, device
):
    with pytest.raises(PluginAccountAuthError, match="transfer_required"):
        migrations.consume(
            test_db, user_id=test_user.id, device_id=device.name, request=transfer[1]
        )
    assert stage(transfer, test_db, test_user, device)["state"] == "staged"


def test_lost_stage_ack_does_not_replace_escrow(transfer, test_db, test_user, device):
    stage(transfer, test_db, test_user, device)
    changed = transfer[1].model_copy(
        update={"credential": SecretStr('{"access_token":"replacement"}')}
    )
    transfer[0].stage(
        test_db, user_id=test_user.id, device_id=device.name, request=changed
    )
    assert prepare(transfer, test_db, test_user, device)["credential"] == (
        transfer[1].credential.get_secret_value()
    )


def test_reservation_blocks_a_second_enrollment(
    transfer, service, installed, test_db, test_user, device
):
    stage(transfer, test_db, test_user, device)
    with pytest.raises(PluginAccountAuthError, match="transfer_pending"):
        fixtures.enroll(
            service, test_db, test_user, installed, account_id=transfer[1].account_id
        )


def test_finish_and_lost_ack_activate_exactly_once(
    transfer, service, installed, test_db, test_user, device
):
    stage(transfer, test_db, test_user, device)
    connection = finish(transfer, test_db, test_user, device)
    assert connection.status == "connected"
    assert connection.device_ids == [device.name]
    assert finish(transfer, test_db, test_user, device) == connection
    escrow = transfer[0]._get(test_db, test_user.id, transfer[1].migration_id)
    assert escrow.is_active is False
    assert "credential" not in escrow.json["spec"]
    assert (
        "synthetic-refresh"
        in fixtures.read(
            service, test_db, test_user, installed, connection
        ).get_secret_value()
    )
    disconnected = service.disconnect(
        test_db,
        user_id=test_user.id,
        connection_id=connection.id,
        expected_revision=connection.revision,
    )
    assert finish(transfer, test_db, test_user, device) == disconnected


@pytest.mark.parametrize("mutation", ["device", "package", "owner", "ciphertext"])
def test_escrow_rejects_changed_identity_or_ciphertext(
    transfer, test_db, test_user, test_admin_user, device, installed, mutation
):
    stage(transfer, test_db, test_user, device)
    if mutation == "device":
        value = deepcopy(device.json)
        value["spec"]["runtimeInstanceId"] = "replacement"
        device.json = value
    elif mutation == "package":
        value = deepcopy(installed.json)
        value["spec"]["components"]["connectors"][0]["accountAuth"][
            "adapter"
        ] = "new.py"
        installed.json = value
    elif mutation == "owner":
        with pytest.raises(PluginAccountAuthError, match="transfer_not_found"):
            transfer[0].prepare(
                test_db,
                user_id=test_admin_user.id,
                device_id=device.name,
                migration_id=transfer[1].migration_id,
            )
        return
    else:
        row = transfer[0]._get(test_db, test_user.id, transfer[1].migration_id)
        value = deepcopy(row.json)
        value["spec"]["account_id"] = "swapped-account"
        row.json = value
    test_db.flush()
    with pytest.raises((PluginAccountAuthError, PluginCredentialCipherError)):
        prepare(transfer, test_db, test_user, device)


def test_escrow_outlives_intent_expiry_for_recovery(
    transfer, test_db, test_user, device, monkeypatch
):
    stage(transfer, test_db, test_user, device)
    monkeypatch.setattr("app.services.plugin_auth_migrations.time.time", lambda: 10**12)
    assert prepare(transfer, test_db, test_user, device)["state"] == "staged"
    assert finish(transfer, test_db, test_user, device).status == "connected"


def test_failed_activation_rolls_back_reservation_and_escrow(
    transfer, service, test_db, test_user, device, monkeypatch
):
    stage(transfer, test_db, test_user, device)
    test_db.commit()
    with monkeypatch.context() as scoped:

        def failed_grant(*args, **kwargs):
            raise PluginAccountAuthError("synthetic_failure")

        scoped.setattr(service, "grant_device", failed_grant)
        with pytest.raises(PluginAccountAuthError, match="synthetic_failure"):
            finish(transfer, test_db, test_user, device)
        test_db.rollback()
    assert service.list_connections(test_db, user_id=test_user.id) == []
    assert transfer[0]._get(test_db, test_user.id, transfer[1].migration_id).is_active
    assert prepare(transfer, test_db, test_user, device)["state"] == "staged"
    assert finish(transfer, test_db, test_user, device).status == "connected"


def test_explicit_resume_rebinds_only_the_same_device_row(
    transfer, migrations, installed, test_db, test_user, device
):
    stage(transfer, test_db, test_user, device)
    value = deepcopy(device.json)
    value["spec"]["runtimeInstanceId"] = "restarted-instance"
    device.json = value
    test_db.flush()
    with pytest.raises(PluginAccountAuthError, match="device_mismatch"):
        prepare(transfer, test_db, test_user, device)
    resumed = migrations.create(
        test_db,
        user_id=test_user.id,
        request=fixtures.migration_request(installed, device),
    )
    assert resumed.id == transfer[1].migration_id
    assert (
        migrations.prepare(
            test_db,
            user_id=test_user.id,
            device_id=device.name,
            migration_id=resumed.id,
        )["operation"]
        == "transfer"
    )
    assert prepare(transfer, test_db, test_user, device)["state"] == "staged"
    value = deepcopy(device.json)
    value["spec"]["deviceId"] = "replacement-runtime"
    device.json = value
    test_db.flush()
    with pytest.raises(PluginAccountAuthError, match="device_mismatch"):
        migrations.create(
            test_db,
            user_id=test_user.id,
            request=fixtures.migration_request(installed, device),
        )


def test_stale_intent_cannot_start_a_transfer(
    transfer, test_db, test_user, device, monkeypatch
):
    monkeypatch.setattr("app.services.plugin_auth_migrations.time.time", lambda: 10**12)
    with pytest.raises(PluginAccountAuthError, match="migration_expired"):
        stage(transfer, test_db, test_user, device)


def test_automatic_relogin_replaces_connected_oauth_after_exclusive_handoff(
    transfer,
    service,
    installed,
    test_db,
    test_user,
    device,
):
    from app.services.plugin_auth_automation import PluginAuthAutomationService

    stage(transfer, test_db, test_user, device)
    original = finish(transfer, test_db, test_user, device)
    automation = PluginAuthAutomationService(service)
    intent = automation.reconcile(
        test_db,
        user_id=test_user.id,
        device_id=device.name,
        installed_ids=[installed.id],
    )["migrations"][0]
    updated = PluginNativeEnrollment(
        migration_id=intent["id"],
        account_id="synthetic-account",
        credential=SecretStr(
            '{"access_token":"new-login","refresh_token":"new-refresh"}'
        ),
    )
    renewed = (transfer[0], updated)
    assert stage(renewed, test_db, test_user, device) == {"state": "staged"}
    pending = service._get(test_db, test_user.id, original.id)
    assert "new-login" not in service._cipher_instance().decrypt(
        pending.json["spec"]["credential"],
        context=service._context(test_user.id, pending.json["spec"]),
    )
    result = finish(renewed, test_db, test_user, device)
    assert result.id == original.id
    current = service._get(test_db, test_user.id, result.id)
    assert "new-login" in service._cipher_instance().decrypt(
        current.json["spec"]["credential"],
        context=service._context(test_user.id, current.json["spec"]),
    )
    assert result.device_ids == original.device_ids
