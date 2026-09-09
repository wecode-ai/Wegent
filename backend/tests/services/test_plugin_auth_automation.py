"""Automatic enrollment respects ownership, revocation and in-flight intent fencing."""

from copy import deepcopy

import pytest
from pydantic import SecretStr, ValidationError

from app.models.kind import Kind
from app.schemas.plugin_account_auth import (
    PluginNativeAutomation,
    PluginNativeEnrollment,
)
from app.services.plugin_account_connections import PluginAccountAuthError
from app.services.plugin_auth_automation import PluginAuthAutomationService
from tests.services.test_plugin_account_connections import (
    device,
    enroll,
    installed,
    service,
)


@pytest.fixture
def automation(service):
    return PluginAuthAutomationService(service)


@pytest.fixture
def local(test_db, test_user):
    row = Kind(
        user_id=test_user.id,
        kind="Device",
        namespace="default",
        name="local",
        is_active=True,
        json={
            "spec": {
                "deviceType": "local",
                "deviceId": "local-runtime",
                "runtimeInstanceId": "local-instance",
            }
        },
    )
    test_db.add(row)
    test_db.flush()
    return row


def reconcile(automation, db, user, installed, device_id="local"):
    return automation.reconcile(
        db, user_id=user.id, device_id=device_id, installed_ids=[installed.id]
    )


def test_install_discovers_credentials_once_and_cloud_grants_automatically(
    automation,
    service,
    test_db,
    test_user,
    installed,
    local,
    device,
):
    result = reconcile(automation, test_db, test_user, installed)
    assert result == reconcile(automation, test_db, test_user, installed)
    intent = result["migrations"][0]["id"]
    connection = automation.migrations.consume(
        test_db,
        user_id=test_user.id,
        device_id="local",
        request=PluginNativeEnrollment(
            migration_id=intent,
            account_id="alice",
            credential=SecretStr('{"username":"alice","password":"synthetic"}'),
        ),
    )
    assert connection.device_ids == ["local"]
    assert len(reconcile(automation, test_db, test_user, installed)["migrations"]) == 1
    assert reconcile(automation, test_db, test_user, installed, "logical-device") == {
        "migrations": []
    }
    connection = service.list_connections(test_db, user_id=test_user.id)[0]
    assert set(connection.device_ids) == {"local", "logical-device"}
    revision = connection.revision
    reconcile(automation, test_db, test_user, installed, "logical-device")
    assert (
        service.list_connections(test_db, user_id=test_user.id)[0].revision == revision
    )


def test_revoked_device_and_disconnected_account_stay_disabled(
    automation,
    service,
    test_db,
    test_user,
    installed,
    local,
    device,
):
    connection = enroll(service, test_db, test_user, installed)
    reconcile(automation, test_db, test_user, installed, "logical-device")
    connection = service.list_connections(test_db, user_id=test_user.id)[0]
    connection = service.revoke_device(
        test_db,
        user_id=test_user.id,
        connection_id=connection.id,
        device_id="logical-device",
        expected_revision=connection.revision,
    )
    for _ in range(2):
        reconcile(automation, test_db, test_user, installed, "logical-device")
    assert service.list_connections(test_db, user_id=test_user.id)[0].device_ids == []
    connection = service.grant_device(
        test_db,
        user_id=test_user.id,
        connection_id=connection.id,
        device_id="logical-device",
        expected_revision=connection.revision,
    )
    assert connection.device_ids == ["logical-device"]
    service.disconnect(
        test_db,
        user_id=test_user.id,
        connection_id=connection.id,
        expected_revision=connection.revision,
    )
    assert reconcile(automation, test_db, test_user, installed) == {"migrations": []}
    reconcile(automation, test_db, test_user, installed, "logical-device")
    assert (
        service.list_connections(test_db, user_id=test_user.id)[0].status
        == "disconnected"
    )


def test_disable_fences_already_issued_intents_and_can_resume(
    automation,
    test_db,
    test_user,
    installed,
    local,
):
    intent = reconcile(automation, test_db, test_user, installed)["migrations"][0]["id"]
    automation.configure(test_db, test_user.id, False)
    assert reconcile(automation, test_db, test_user, installed) == {"migrations": []}
    with pytest.raises(PluginAccountAuthError, match="automation_disabled"):
        automation.migrations.prepare(
            test_db, user_id=test_user.id, device_id="local", migration_id=intent
        )
    automation.configure(test_db, test_user.id, True)
    assert (
        reconcile(automation, test_db, test_user, installed)["migrations"][0]["id"]
        == intent
    )


def test_new_owned_device_granted_but_replaced_runtime_and_other_owner_denied(
    automation,
    service,
    test_db,
    test_user,
    test_admin_user,
    installed,
    device,
):
    enroll(service, test_db, test_user, installed)
    reconcile(automation, test_db, test_user, installed, "logical-device")
    changed = deepcopy(device.json)
    changed["spec"]["runtimeInstanceId"] = "replacement"
    device.json = changed
    test_db.flush()
    reconcile(automation, test_db, test_user, installed, "logical-device")
    connection = service.list_connections(test_db, user_id=test_user.id)[0]
    with pytest.raises(PluginAccountAuthError, match="device_not_granted"):
        service.read_for_device(
            test_db,
            user_id=test_user.id,
            device_id="logical-device",
            connection_id=connection.id,
            installed_plugin_id=installed.id,
            expected_revision=connection.revision,
        )
    new = Kind(
        user_id=test_user.id,
        kind="Device",
        namespace="default",
        name="new-cloud",
        is_active=True,
        json={
            "spec": {
                "deviceType": "cloud",
                "deviceId": "new-runtime",
                "runtimeInstanceId": "new-instance",
            }
        },
    )
    test_db.add(new)
    test_db.flush()
    reconcile(automation, test_db, test_user, installed, "new-cloud")
    assert (
        "new-cloud"
        in service.list_connections(test_db, user_id=test_user.id)[0].device_ids
    )
    with pytest.raises(PluginAccountAuthError):
        reconcile(automation, test_db, test_admin_user, installed, "new-cloud")


def test_disabled_uninstalled_and_foreign_plugins_never_receive_intents(
    automation,
    test_db,
    test_user,
    test_admin_user,
    installed,
    local,
):
    assert automation.reconcile(
        test_db, user_id=test_user.id, device_id="local", installed_ids=[]
    ) == {"migrations": []}
    installed.json = {"spec": {**installed.json["spec"], "enabled": False}}
    test_db.flush()
    assert reconcile(automation, test_db, test_user, installed) == {"migrations": []}
    installed.user_id = test_admin_user.id
    test_db.flush()
    assert reconcile(automation, test_db, test_user, installed) == {"migrations": []}


@pytest.mark.parametrize(
    "payload",
    [
        {"installed_plugin_ids": [1], "user_id": 4},
        {"installed_plugin_ids": [True]},
        {"installed_plugin_ids": [1, 1]},
        {"installed_plugin_ids": [0]},
    ],
)
def test_native_automation_rejects_identity_override_and_invalid_ids(payload):
    with pytest.raises(ValidationError):
        PluginNativeAutomation.model_validate(payload)
