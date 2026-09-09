"""Revocation survives disconnect, concurrent refresh and native worker failures."""

import json
import time
from copy import deepcopy

import pytest

from app.schemas.plugin_account_auth import PluginRevocationFinish
from app.services.plugin_account_connections import PluginAccountAuthError
from app.services.plugin_oauth_revocations import PluginOAuthRevocations
from tests.services import test_plugin_oauth_operations as fixtures

device = fixtures.device
installed = fixtures.installed
service = fixtures.service
oauth = fixtures.oauth


@pytest.fixture
def revoked(oauth, service, test_db, test_user):
    connection = oauth[3]
    metadata = service.disconnect(
        test_db,
        user_id=test_user.id,
        connection_id=connection.id,
        expected_revision=connection.revision,
    )
    return PluginOAuthRevocations(service), metadata


def claim(revoked, db, user, device):
    return revoked[0].begin(
        db, user_id=user.id, device_id=device.name, connection_id=revoked[1].id
    )


def finish(revoked, db, user, device, lease, succeeded=True):
    return revoked[0].finish(
        db,
        user_id=user.id,
        device_id=device.name,
        request=PluginRevocationFinish(
            connection_id=revoked[1].id,
            operation_id=lease["operation_id"],
            succeeded=succeeded,
        ),
    )


def test_disconnect_denies_business_and_revocation_erases_retained_secret(
    revoked, oauth, service, test_db, test_user, device, installed
):
    worker, metadata = revoked
    assert metadata.provider_revocation == "pending"
    assert metadata.device_ids == []
    assert "credential" not in metadata.model_dump()
    spec = service._get(test_db, test_user.id, metadata.id).json["spec"]
    assert spec["credential"] is None
    assert "synthetic-old-refresh" not in json.dumps(spec)
    with pytest.raises(PluginAccountAuthError, match="device_not_granted"):
        oauth[1].prepare(
            test_db, user_id=test_user.id, device_id=device.name, request=oauth[2]
        )
    with pytest.raises(PluginAccountAuthError, match="revocation_pending"):
        fixtures.enroll(
            service, test_db, test_user, installed, expected_revision=metadata.revision
        )
    assert worker.pending(test_db, user_id=test_user.id, device_id=device.name) == [
        metadata.id
    ]
    lease = claim(revoked, test_db, test_user, device)
    assert json.loads(lease["credential"])["refresh_token"] == "synthetic-old-refresh"
    assert claim(revoked, test_db, test_user, device) == {"state": "unavailable"}
    assert finish(revoked, test_db, test_user, device, lease) == {"state": "revoked"}
    spec = service._get(test_db, test_user.id, metadata.id).json["spec"]
    assert "credential" not in spec["oauthRevocation"]
    revision = spec["revision"]
    assert finish(revoked, test_db, test_user, device, lease) == {"state": "revoked"}
    assert (
        service._get(test_db, test_user.id, metadata.id).json["spec"]["revision"]
        == revision
    )


def test_recreated_runtime_cannot_claim_or_finish_old_device_work(
    revoked, service, test_db, test_user, device
):
    lease = claim(revoked, test_db, test_user, device)
    value = deepcopy(device.json)
    value["spec"]["runtimeInstanceId"] = "replacement-instance"
    device.json = value
    test_db.flush()
    assert (
        revoked[0].pending(test_db, user_id=test_user.id, device_id=device.name) == []
    )
    with pytest.raises(PluginAccountAuthError, match="device_not_granted"):
        claim(revoked, test_db, test_user, device)
    with pytest.raises(PluginAccountAuthError, match="operation_mismatch"):
        finish(revoked, test_db, test_user, device, lease)
    with pytest.raises(PluginAccountAuthError, match="connection_not_found"):
        revoked[0].begin(
            test_db,
            user_id=test_user.id + 1,
            device_id=device.name,
            connection_id=revoked[1].id,
        )


def test_removed_plugin_requires_provider_action_without_exporting_credentials(
    revoked, service, test_db, test_user, device, installed
):
    installed.is_active = False
    test_db.flush()
    assert claim(revoked, test_db, test_user, device) == {"state": "unavailable"}
    current = service.list_connections(test_db, user_id=test_user.id)[0]
    assert current.provider_revocation == "attention"
    confirmed = revoked[0].confirm_external(
        test_db,
        user_id=test_user.id,
        connection_id=current.id,
        expected_revision=current.revision,
    )
    assert confirmed.provider_revocation == "confirmed"


def test_failed_revoke_backs_off_and_user_retry_binds_current_device(
    revoked, service, test_db, test_user, device
):
    lease = claim(revoked, test_db, test_user, device)
    assert finish(revoked, test_db, test_user, device, lease, False) == {
        "state": "pending"
    }
    assert (
        revoked[0].pending(test_db, user_id=test_user.id, device_id=device.name) == []
    )
    metadata = service.list_connections(test_db, user_id=test_user.id)[0]
    retried = revoked[0].retry(
        test_db,
        user_id=test_user.id,
        connection_id=metadata.id,
        device_id=device.name,
        expected_revision=metadata.revision,
    )
    assert retried.provider_revocation == "pending"
    with pytest.raises(PluginAccountAuthError, match="operation_mismatch"):
        finish(revoked, test_db, test_user, device, lease)
    assert (
        claim(revoked, test_db, test_user, device)["operation_id"]
        != lease["operation_id"]
    )


def test_late_rotation_is_revoke_only_and_never_restores_business_access(
    oauth, service, test_db, test_user, device
):
    lease = fixtures.begin(oauth, test_db, test_user, device)
    current = service.list_connections(test_db, user_id=test_user.id)[0]
    metadata = service.disconnect(
        test_db,
        user_id=test_user.id,
        connection_id=current.id,
        expected_revision=current.revision,
    )
    worker = PluginOAuthRevocations(service)
    assert worker.pending(test_db, user_id=test_user.id, device_id=device.name) == []
    oauth[0].finish(
        test_db,
        user_id=test_user.id,
        device_id=device.name,
        request=fixtures.finish_request(lease),
    )
    revocation = worker.begin(
        test_db, user_id=test_user.id, device_id=device.name, connection_id=metadata.id
    )
    assert (
        json.loads(revocation["credential"])["refresh_token"] == "synthetic-new-refresh"
    )
    spec = service._get(test_db, test_user.id, metadata.id).json["spec"]
    assert spec["status"] == "disconnected" and spec["credential"] is None
    assert spec["deviceGrants"] == {}


def test_unknown_rotation_requires_explicit_provider_confirmation(
    oauth, service, test_db, test_user, device
):
    lease = fixtures.begin(oauth, test_db, test_user, device)
    oauth[0].finish(
        test_db,
        user_id=test_user.id,
        device_id=device.name,
        request=fixtures.finish_request(
            lease, succeeded=False, credential=None, account_id=None
        ),
    )
    current = service.list_connections(test_db, user_id=test_user.id)[0]
    metadata = service.disconnect(
        test_db,
        user_id=test_user.id,
        connection_id=current.id,
        expected_revision=current.revision,
    )
    worker = PluginOAuthRevocations(service)
    assert metadata.provider_revocation == "attention"
    with pytest.raises(PluginAccountAuthError, match="provider_action_required"):
        worker.retry(
            test_db,
            user_id=test_user.id,
            connection_id=metadata.id,
            device_id=device.name,
            expected_revision=metadata.revision,
        )
    confirmed = worker.confirm_external(
        test_db,
        user_id=test_user.id,
        connection_id=metadata.id,
        expected_revision=metadata.revision,
    )
    assert confirmed.provider_revocation == "confirmed"
    assert service._get(test_db, test_user.id, metadata.id).json["spec"][
        "oauthRevocation"
    ] == {"state": "confirmed"}


def test_lost_refresh_result_becomes_attention_after_lease_expires(
    oauth, service, test_db, test_user, device, monkeypatch
):
    fixtures.begin(oauth, test_db, test_user, device)
    current = service.list_connections(test_db, user_id=test_user.id)[0]
    metadata = service.disconnect(
        test_db,
        user_id=test_user.id,
        connection_id=current.id,
        expected_revision=current.revision,
    )
    future = time.time() + 100
    monkeypatch.setattr(
        "app.services.plugin_oauth_revocations.time.time", lambda: future
    )
    worker = PluginOAuthRevocations(service)
    assert worker.begin(
        test_db, user_id=test_user.id, device_id=device.name, connection_id=metadata.id
    ) == {"state": "unavailable"}
    assert (
        service.list_connections(test_db, user_id=test_user.id)[0].provider_revocation
        == "attention"
    )


def test_active_worker_cannot_be_superseded_by_retry_or_user_confirmation(
    revoked, service, test_db, test_user, device
):
    claim(revoked, test_db, test_user, device)
    current = service.list_connections(test_db, user_id=test_user.id)[0]
    with pytest.raises(PluginAccountAuthError, match="revocation_in_progress"):
        revoked[0].retry(
            test_db,
            user_id=test_user.id,
            connection_id=current.id,
            device_id=device.name,
            expected_revision=current.revision,
        )
    with pytest.raises(PluginAccountAuthError, match="operation_unsupported"):
        revoked[0].confirm_external(
            test_db,
            user_id=test_user.id,
            connection_id=current.id,
            expected_revision=current.revision,
        )
