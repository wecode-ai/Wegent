"""Local edits propagate automatically; unchanged sources cannot undo cloud refresh."""

import json
from copy import deepcopy

import pytest
from pydantic import SecretStr

from app.schemas.plugin_account_auth import PluginNativeEnrollment
from app.services.plugin_account_connections import PluginAccountAuthError
from app.services.plugin_auth_source_sync import PluginAuthSourceSync
from tests.services.test_plugin_account_connections import device, installed, service
from tests.services.test_plugin_auth_automation import automation, local, reconcile


def sync(automation, db, user, installed, password):
    intent = reconcile(automation, db, user, installed)["migrations"][0]
    return automation.migrations.consume(
        db,
        user_id=user.id,
        device_id="local",
        request=PluginNativeEnrollment(
            migration_id=intent["id"],
            account_id="alice",
            credential=SecretStr(
                json.dumps({"username": "alice", "password": password})
            ),
        ),
    )


def test_local_password_updates_cloud_without_migration_or_grant_clicks(
    automation,
    service,
    test_db,
    test_user,
    installed,
    local,
    device,
):
    connection = sync(automation, test_db, test_user, installed, "first-synthetic")
    reconcile(automation, test_db, test_user, installed, "logical-device")
    connection = service.list_connections(test_db, user_id=test_user.id)[0]
    unchanged = sync(automation, test_db, test_user, installed, "first-synthetic")
    assert unchanged.revision == connection.revision
    changed = sync(automation, test_db, test_user, installed, "updated-synthetic")
    # Credential replacement and its source observation each advance the CAS.
    assert changed.revision == connection.revision + 2
    assert set(changed.device_ids) == {"local", "logical-device"}
    secret = service.read_for_device(
        test_db,
        user_id=test_user.id,
        device_id="logical-device",
        installed_plugin_id=installed.id,
        connection_id=changed.id,
        expected_revision=changed.revision,
    )
    assert json.loads(secret.get_secret_value())["password"] == "updated-synthetic"
    stored = service._get(test_db, test_user.id, changed.id)
    assert "updated-synthetic" not in json.dumps(stored.json)
    assert "localAuthSources" not in changed.model_dump()


def test_source_observation_advances_revision_and_rejects_stale_device_updates(
    automation, service, test_db, test_user, installed, local, device
):
    connection = sync(automation, test_db, test_user, installed, "synthetic")
    row = service._get(test_db, test_user.id, connection.id)
    observation = deepcopy(row.json["spec"]["localAuthSources"]["local"])
    _, binding = service._device_binding(test_db, test_user.id, local.name)
    source = {
        "source_identity": row.json["spec"]["sourceIdentity"],
        "connector_slug": "mail",
        "device_id": "local",
        "binding": binding,
    }

    updated = PluginAuthSourceSync(service).remember(
        test_db, test_user.id, connection.id, source, observation
    )

    assert updated.revision == connection.revision + 1
    assert (
        service._get(test_db, test_user.id, updated.id).json["spec"]["revision"]
        == updated.revision
    )
    with pytest.raises(PluginAccountAuthError, match="plugin_auth_revision_conflict"):
        service.grant_device(
            test_db,
            user_id=test_user.id,
            connection_id=connection.id,
            device_id=device.name,
            expected_revision=connection.revision,
        )


def test_unchanged_local_source_never_overwrites_newer_cloud_credentials(
    automation,
    service,
    test_db,
    test_user,
    installed,
    local,
):
    connection = sync(automation, test_db, test_user, installed, "local-original")
    row = service._get(test_db, test_user.id, connection.id)
    spec = deepcopy(row.json["spec"])
    # The same source-observation rule protects server-refreshed OAuth tokens.
    spec["credential"] = service._cipher_instance().encrypt(
        '{"username":"alice","password":"cloud-newer"}',
        context=service._context(test_user.id, spec),
    )
    service._advance(test_db, row, spec, connection.revision)
    latest = service.list_connections(test_db, user_id=test_user.id)[0]
    repeated = sync(automation, test_db, test_user, installed, "local-original")
    assert repeated.revision == latest.revision
    secret = service.read_for_device(
        test_db,
        user_id=test_user.id,
        device_id="local",
        installed_plugin_id=installed.id,
        connection_id=repeated.id,
        expected_revision=repeated.revision,
    )
    assert "cloud-newer" in secret.get_secret_value()
