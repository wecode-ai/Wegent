"""Revocation survives disconnect, concurrent refresh and native worker failures."""

import json
import time
from copy import deepcopy
from unittest.mock import Mock

import pytest
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.schemas.plugin_account_auth import PluginRevocationFinish
from app.services.plugin_account_connections import (
    PluginAccountAuthError,
    PluginAccountConnectionService,
)
from app.services.plugin_oauth_revocations import PluginOAuthRevocations
from tests.services import test_plugin_oauth_operations as fixtures

device = fixtures.device
installed = fixtures.installed
service = fixtures.service
oauth = fixtures.oauth


@pytest.mark.parametrize(
    "operation, parameters",
    [
        ("begin", {"connection_id": "a" * 64, "device_id": "device"}),
        (
            "finish",
            {
                "device_id": "device",
                "request": PluginRevocationFinish(
                    connection_id="a" * 64, operation_id="b" * 64, succeeded=True
                ),
            },
        ),
        (
            "retry",
            {
                "connection_id": "a" * 64,
                "device_id": "device",
                "expected_revision": 1,
            },
        ),
        ("confirm_external", {"connection_id": "a" * 64, "expected_revision": 1}),
    ],
)
def test_revocation_requires_coordination_before_reading_credentials(
    operation, parameters, monkeypatch
):
    connections = PluginAccountConnectionService()
    worker = PluginOAuthRevocations(connections)
    db = Mock(spec=Session)

    def unavailable(*_args):
        raise PluginAccountAuthError("plugin_auth_backend_unavailable", 503)

    monkeypatch.setattr(connections, "_coordinate_owner", unavailable)

    with pytest.raises(PluginAccountAuthError, match="plugin_auth_backend_unavailable"):
        getattr(worker, operation)(db, user_id=1, **parameters)

    assert db.mock_calls == []


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
    page = worker.pending(test_db, user_id=test_user.id, device_id=device.name)
    targets = page["revocations"]
    assert page["next_cursor"] is None
    assert [target["connection_id"] for target in targets] == [metadata.id]
    assert targets[0]["package"]["installed_plugin_id"] == installed.id
    assert targets[0]["package"]["connector_slug"] == "mail"
    assert "credential" not in targets[0]
    pending = service._get(test_db, test_user.id, metadata.id).json["spec"][
        "oauthRevocation"
    ]
    assert pending["state"] == "pending"
    assert "operationId" not in pending
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


def test_pending_pages_discover_jobs_after_ten_unclaimed_revocations(
    revoked, service, test_db, test_user, device
):
    worker, metadata = revoked
    original = service._get(test_db, test_user.id, metadata.id)
    rows = [original]
    for index in range(10):
        row = Kind(
            user_id=test_user.id,
            kind=original.kind,
            namespace=original.namespace,
            name=f"{index:064x}",
            is_active=True,
            json=deepcopy(original.json),
        )
        test_db.add(row)
        rows.append(row)
    test_db.flush()
    before = [deepcopy(row.json) for row in rows]

    first = worker.pending(test_db, user_id=test_user.id, device_id=device.name)
    second = worker.pending(
        test_db,
        user_id=test_user.id,
        device_id=device.name,
        after_id=first["next_cursor"],
    )

    assert [item["connection_id"] for item in first["revocations"]] == [
        row.name for row in rows[:10]
    ]
    assert first["next_cursor"] == rows[9].id
    assert [item["connection_id"] for item in second["revocations"]] == [rows[10].name]
    assert second["next_cursor"] is None
    assert [row.json for row in rows] == before


def test_recreated_runtime_cannot_claim_or_finish_old_device_work(
    revoked, service, test_db, test_user, device
):
    lease = claim(revoked, test_db, test_user, device)
    value = deepcopy(device.json)
    value["spec"]["runtimeInstanceId"] = "replacement-instance"
    device.json = value
    test_db.flush()
    assert revoked[0].pending(test_db, user_id=test_user.id, device_id=device.name) == {
        "revocations": [],
        "next_cursor": None,
    }
    with pytest.raises(PluginAccountAuthError, match="device_not_granted"):
        claim(revoked, test_db, test_user, device)
    with pytest.raises(PluginAccountAuthError, match="operation_mismatch"):
        finish(revoked, test_db, test_user, device, lease)


def test_another_active_owner_cannot_claim_revocation(
    revoked, test_db, test_admin_user, device
):
    test_db.commit()
    with pytest.raises(PluginAccountAuthError, match="connection_not_found"):
        revoked[0].begin(
            test_db,
            user_id=test_admin_user.id,
            device_id=device.name,
            connection_id=revoked[1].id,
        )


def test_missing_owner_cannot_claim_revocation(revoked, test_db, test_user, device):
    test_db.commit()
    with pytest.raises(PluginAccountAuthError, match="owner_unavailable"):
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
    assert revoked[0].pending(test_db, user_id=test_user.id, device_id=device.name) == {
        "revocations": [{"connection_id": revoked[1].id, "package": None}],
        "next_cursor": None,
    }
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
    assert revoked[0].pending(test_db, user_id=test_user.id, device_id=device.name) == {
        "revocations": [],
        "next_cursor": None,
    }
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
    assert worker.pending(test_db, user_id=test_user.id, device_id=device.name) == {
        "revocations": [],
        "next_cursor": None,
    }
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
