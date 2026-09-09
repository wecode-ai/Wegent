"""Synthetic OAuth lifecycle and concurrent state-change contracts."""

import json
import time
from copy import deepcopy

import pytest
from pydantic import SecretStr

from app.schemas.plugin_account_auth import PluginNativeExecution, PluginOAuthFinish
from app.services.plugin_account_connections import PluginAccountAuthError
from app.services.plugin_auth_execution import PluginAuthExecutionService
from app.services.plugin_oauth_credentials import business_credential
from app.services.plugin_oauth_operations import PluginOAuthOperations
from tests.services import test_plugin_account_connections as fixtures

device = fixtures.device
installed = fixtures.installed
service = fixtures.service
enroll = fixtures.enroll
grant = fixtures.grant
migrations = fixtures.migrations


def test_business_credential_excludes_provider_renewal_material():
    credential = SecretStr(
        json.dumps(
            {
                "access_token": "synthetic-access",
                "refresh_token": "synthetic-refresh",
                "provider_private": {"signing_key": "synthetic-key"},
                "client_secret": "synthetic-client-secret",
                "persistent_code": "synthetic-code",
                "corp_id": "public-corp",
            }
        )
    )
    business = json.loads(business_credential(credential, "oauth2").get_secret_value())
    assert business == {"access_token": "synthetic-access", "corp_id": "public-corp"}


def test_private_provider_fields_require_an_object():
    with pytest.raises(PluginAccountAuthError, match="invalid_credential"):
        business_credential(
            SecretStr('{"access_token":"synthetic","provider_private":[]}'), "oauth2"
        )


@pytest.fixture
def oauth(service, test_db, test_user, installed, device):
    value = deepcopy(installed.json)
    definition = value["spec"]["components"]["connectors"][0]["accountAuth"]
    definition.update(
        credentialType="oauth2", oauth2=["authorize", "refresh", "revoke"]
    )
    value["spec"]["packageRef"] = {"checksum": "sha256:" + "a" * 64}
    installed.json = value
    test_db.flush()
    credential = SecretStr(
        json.dumps(
            {
                "access_token": "synthetic-old-access",
                "refresh_token": "synthetic-old-refresh",
                "expires_at": time.time() - 1,
            }
        )
    )
    connection = grant(
        service,
        test_db,
        test_user,
        enroll(service, test_db, test_user, installed, credential=credential),
    )
    execution = PluginAuthExecutionService(service)
    operations = PluginOAuthOperations(execution)
    request = PluginNativeExecution(
        installed_plugin_id=installed.id, connector_slug="mail"
    )
    return operations, execution, request, connection


def begin(oauth, db, user, device):
    return oauth[0].begin(db, user_id=user.id, device_id=device.name, request=oauth[2])


def finish_request(lease, **changes):
    return PluginOAuthFinish(
        **{
            "connection_id": lease["connection_id"],
            "operation_id": lease["operation_id"],
            "succeeded": True,
            "account_id": "account-1",
            "credential": SecretStr(
                json.dumps(
                    {
                        "access_token": "synthetic-new-access",
                        "refresh_token": "synthetic-new-refresh",
                        "expires_at": time.time() + 3600,
                    }
                )
            ),
            **changes,
        }
    )


def test_refresh_is_single_owner_and_business_never_receives_refresh_token(
    oauth, service, test_db, test_user, device
):
    with pytest.raises(PluginAccountAuthError, match="refresh_required"):
        oauth[1].prepare(
            test_db, user_id=test_user.id, device_id=device.name, request=oauth[2]
        )
    lease = begin(oauth, test_db, test_user, device)
    with pytest.raises(PluginAccountAuthError, match="refresh_in_progress"):
        begin(oauth, test_db, test_user, device)
    result = oauth[0].finish(
        test_db,
        user_id=test_user.id,
        device_id=device.name,
        request=finish_request(lease),
    )
    assert result == {"state": "finished"}
    revision = service.list_connections(test_db, user_id=test_user.id)[0].revision
    oauth[0].finish(
        test_db,
        user_id=test_user.id,
        device_id=device.name,
        request=finish_request(lease),
    )
    assert (
        service.list_connections(test_db, user_id=test_user.id)[0].revision == revision
    )
    business = oauth[1].prepare(
        test_db, user_id=test_user.id, device_id=device.name, request=oauth[2]
    )
    payload = json.loads(business["credential"])
    assert payload["access_token"] == "synthetic-new-access"
    assert "refresh_token" not in payload
    assert begin(oauth, test_db, test_user, device) == {"state": "ready"}


@pytest.mark.parametrize("attempted", [True, False])
def test_only_unattempted_operations_can_be_released_for_retry(
    oauth, test_db, test_user, device, attempted
):
    lease = begin(oauth, test_db, test_user, device)
    result = oauth[0].finish(
        test_db,
        user_id=test_user.id,
        device_id=device.name,
        request=finish_request(
            lease,
            succeeded=False,
            attempted=attempted,
            account_id=None,
            credential=None,
        ),
    )
    assert result["state"] == ("uncertain" if attempted else "cancelled")
    if attempted:
        with pytest.raises(PluginAccountAuthError, match="reconnect_required"):
            begin(oauth, test_db, test_user, device)
    else:
        assert (
            begin(oauth, test_db, test_user, device)["operation_id"]
            != lease["operation_id"]
        )


def test_expired_lease_never_reuses_a_possibly_rotated_refresh_token(
    oauth, test_db, test_user, device, monkeypatch
):
    lease = begin(oauth, test_db, test_user, device)
    future = time.time() + 100
    monkeypatch.setattr(
        "app.services.plugin_oauth_operations.time.time", lambda: future
    )
    with pytest.raises(PluginAccountAuthError, match="reconnect_required"):
        begin(oauth, test_db, test_user, device)
    with pytest.raises(PluginAccountAuthError, match="reconnect_required"):
        oauth[0].finish(
            test_db,
            user_id=test_user.id,
            device_id=device.name,
            request=finish_request(lease),
        )


def test_refresh_completion_preserves_a_device_revocation(
    oauth, service, test_db, test_user, device
):
    lease = begin(oauth, test_db, test_user, device)
    connection = service.list_connections(test_db, user_id=test_user.id)[0]
    service.revoke_device(
        test_db,
        user_id=test_user.id,
        connection_id=connection.id,
        device_id=device.name,
        expected_revision=connection.revision,
    )
    oauth[0].finish(
        test_db,
        user_id=test_user.id,
        device_id=device.name,
        request=finish_request(lease),
    )
    assert service.list_connections(test_db, user_id=test_user.id)[0].device_ids == []
    with pytest.raises(PluginAccountAuthError, match="device_not_granted"):
        oauth[1].prepare(
            test_db, user_id=test_user.id, device_id=device.name, request=oauth[2]
        )


def test_late_refresh_cannot_reconnect_a_disconnected_account(
    oauth, service, test_db, test_user, device
):
    lease = begin(oauth, test_db, test_user, device)
    connection = service.list_connections(test_db, user_id=test_user.id)[0]
    service.disconnect(
        test_db,
        user_id=test_user.id,
        connection_id=connection.id,
        expected_revision=connection.revision,
    )
    oauth[0].finish(
        test_db,
        user_id=test_user.id,
        device_id=device.name,
        request=finish_request(lease),
    )
    assert (
        service._get(test_db, test_user.id, connection.id).json["spec"]["credential"]
        is None
    )


def test_refresh_cannot_change_account_identity(oauth, test_db, test_user, device):
    lease = begin(oauth, test_db, test_user, device)
    with pytest.raises(PluginAccountAuthError, match="invalid_refresh_result"):
        oauth[0].finish(
            test_db,
            user_id=test_user.id,
            device_id=device.name,
            request=finish_request(lease, account_id="other-account"),
        )


def test_new_authorization_invalidates_an_old_refresh_result(
    oauth, service, test_db, test_user, installed, device
):
    lease = begin(oauth, test_db, test_user, device)
    current = service.list_connections(test_db, user_id=test_user.id)[0]
    replacement = SecretStr(json.dumps({"access_token": "synthetic-reauthorized"}))
    enrolled = enroll(
        service,
        test_db,
        test_user,
        installed,
        credential=replacement,
        expected_revision=current.revision,
    )
    with pytest.raises(PluginAccountAuthError, match="operation_mismatch"):
        oauth[0].finish(
            test_db,
            user_id=test_user.id,
            device_id=device.name,
            request=finish_request(lease),
        )
    assert (
        service.list_connections(test_db, user_id=test_user.id)[0].revision
        == enrolled.revision
    )
    result = oauth[1].prepare(
        test_db, user_id=test_user.id, device_id=device.name, request=oauth[2]
    )
    assert json.loads(result["credential"])["access_token"] == "synthetic-reauthorized"


def test_refresh_lease_cannot_be_finished_by_a_replacement_runtime(
    oauth, test_db, test_user, device
):
    lease = begin(oauth, test_db, test_user, device)
    value = deepcopy(device.json)
    value["spec"]["runtimeInstanceId"] = "replacement-instance"
    device.json = value
    test_db.flush()
    with pytest.raises(PluginAccountAuthError, match="operation_mismatch"):
        oauth[0].finish(
            test_db,
            user_id=test_user.id,
            device_id=device.name,
            request=finish_request(lease),
        )


def test_authorize_intent_is_bound_to_the_declared_provider_operation(
    oauth, migrations, test_db, test_user, installed, device
):
    fixtures.set_local_device(test_db, device)
    request = fixtures.migration_request(installed, device).model_copy(
        update={"operation": "authorize"}
    )
    ticket = migrations.create(test_db, user_id=test_user.id, request=request)
    prepared = migrations.prepare(
        test_db, user_id=test_user.id, device_id=device.name, migration_id=ticket.id
    )
    assert prepared["operation"] == "authorize"
    value = deepcopy(installed.json)
    value["spec"]["components"]["connectors"][0]["accountAuth"]["oauth2"] = ["refresh"]
    installed.json = value
    test_db.flush()
    with pytest.raises(PluginAccountAuthError, match="plugin_mismatch"):
        migrations.prepare(
            test_db, user_id=test_user.id, device_id=device.name, migration_id=ticket.id
        )
    with pytest.raises(PluginAccountAuthError, match="operation_unsupported"):
        migrations.create(test_db, user_id=test_user.id, request=request)
