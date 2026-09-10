import json
from copy import deepcopy

import pytest
from pydantic import SecretStr

from app.core.config import settings
from app.models.kind import Kind
from app.schemas.plugin_account_auth import PluginCredentialWrite
from app.services.plugin_account_connections import (
    CONNECTION_NAMESPACE,
    PluginAccountAuthError,
    PluginAccountConnectionService,
)
from app.services.plugin_credential_cipher import (
    PluginCredentialCipher,
    PluginCredentialCipherError,
)


@pytest.fixture
def service():
    return PluginAccountConnectionService(
        PluginCredentialCipher("test", {"test": b"a" * 32})
    )


@pytest.fixture
def installed(test_db, test_user):
    row = Kind(
        user_id=test_user.id,
        kind="InstalledPlugin",
        name="mail",
        namespace="default",
        json={
            "spec": {
                "source": {
                    "type": "marketplace",
                    "providerKey": "wegent",
                    "pluginKey": "mail",
                    "catalogItemId": "101",
                },
                "components": {
                    "connectors": [
                        {
                            "slug": "mail",
                            "accountAuth": {
                                "protocolVersion": 1,
                                "credentialType": "password",
                                "adapter": "scripts/account-auth.py",
                            },
                        }
                    ]
                },
            }
        },
        is_active=True,
    )
    test_db.add(row)
    test_db.flush()
    return row


@pytest.fixture
def device(test_db, test_user):
    row = Kind(
        user_id=test_user.id,
        kind="Device",
        name="logical-device",
        namespace="default",
        json={
            "spec": {
                "deviceType": "cloud",
                "deviceId": "runtime-device",
                "runtimeInstanceId": "instance-1",
            }
        },
        is_active=True,
    )
    test_db.add(row)
    test_db.flush()
    return row


def enroll(service, db, user, installed, **changes):
    payload = dict(
        installed_plugin_id=installed.id,
        connector_slug="mail",
        account_id="account-1",
        account_label="Work mailbox",
        credential=SecretStr('{"password":"test-password"}'),
        expected_revision=0,
    )
    payload.update(changes)
    return service.enroll(db, user_id=user.id, request=PluginCredentialWrite(**payload))


def test_record_route_binds_exact_app_when_alias_is_shared(service, test_db, test_user):
    devices = []
    for index in range(2):
        device = Kind(
            user_id=test_user.id,
            kind="Device",
            namespace="default",
            name=f"installation-{index}",
            is_active=True,
            json={
                "spec": {
                    "deviceType": "app",
                    "deviceId": f"installation-{index}",
                    "appDeviceId": "shared-desktop-alias",
                    "runtimeInstanceId": f"instance-{index}",
                }
            },
        )
        test_db.add(device)
        devices.append(device)
    test_db.flush()
    route = f"app-record-{devices[1].id}"

    logical, binding = service._device_binding(test_db, test_user.id, route)

    assert logical == route
    assert binding == {
        "deviceRowId": devices[1].id,
        "runtimeDeviceId": route,
        "runtimeInstanceId": "instance-1",
    }
    with pytest.raises(PluginAccountAuthError, match="plugin_auth_device_not_found"):
        service._device_binding(test_db, test_user.id + 1, route)


def read(service, db, user, installed, connection, device_id="logical-device"):
    return service.read_for_device(
        db,
        user_id=user.id,
        connection_id=connection.id,
        device_id=device_id,
        installed_plugin_id=installed.id,
        expected_revision=connection.revision,
    )


def grant(service, db, user, connection, device_id="runtime-device"):
    return service.grant_device(
        db,
        user_id=user.id,
        connection_id=connection.id,
        device_id=device_id,
        expected_revision=connection.revision,
    )


def test_enrollment_metadata_never_discloses_credentials(
    service, test_db, test_user, installed
):
    connection = enroll(service, test_db, test_user, installed)
    row = test_db.query(Kind).filter(Kind.namespace == CONNECTION_NAMESPACE).one()
    assert "test-password" not in json.dumps(row.json)
    assert connection.revision == 1
    assert connection.device_ids == []
    metadata = service.list_connections(test_db, user_id=test_user.id)
    assert "ciphertext" not in metadata[0].model_dump_json()
    assert "test-password" not in metadata[0].model_dump_json()


def test_owned_device_needs_explicit_grant(
    service, test_db, test_user, installed, device
):
    connection = enroll(service, test_db, test_user, installed)
    with pytest.raises(PluginAccountAuthError, match="device_not_granted"):
        read(service, test_db, test_user, installed, connection)
    connection = grant(service, test_db, test_user, connection)
    credential = read(service, test_db, test_user, installed, connection)
    assert connection.device_ids == ["logical-device"]
    assert "test-password" in credential.get_secret_value()
    assert "test-password" not in repr(credential)


def test_other_user_cannot_read_list_or_grant(
    service, test_db, test_user, installed, device
):
    connection = enroll(service, test_db, test_user, installed)
    assert service.list_connections(test_db, user_id=test_user.id + 1) == []
    with pytest.raises(PluginAccountAuthError, match="connection_not_found"):
        service.grant_device(
            test_db,
            user_id=test_user.id + 1,
            connection_id=connection.id,
            device_id=device.name,
            expected_revision=1,
        )
    with pytest.raises(PluginAccountAuthError, match="connection_not_found"):
        service.read_for_device(
            test_db,
            user_id=test_user.id + 1,
            connection_id=connection.id,
            device_id=device.name,
            installed_plugin_id=installed.id,
            expected_revision=1,
        )


def test_other_users_device_cannot_be_granted(
    service, test_db, test_user, installed, device
):
    device.user_id = test_user.id + 1
    test_db.flush()
    connection = enroll(service, test_db, test_user, installed)
    with pytest.raises(PluginAccountAuthError, match="device_not_found"):
        grant(service, test_db, test_user, connection)


def test_legacy_device_without_instance_identity_requires_upgrade(
    service, test_db, test_user, installed, device
):
    data = deepcopy(device.json)
    data["spec"].pop("runtimeInstanceId")
    device.json = data
    test_db.flush()
    connection = enroll(service, test_db, test_user, installed)
    with pytest.raises(PluginAccountAuthError, match="device_upgrade_required"):
        grant(service, test_db, test_user, connection)


def test_stale_enrollment_and_grants_do_not_overwrite(
    service, test_db, test_user, installed, device
):
    connection = enroll(service, test_db, test_user, installed)
    with pytest.raises(PluginAccountAuthError, match="revision_conflict"):
        enroll(service, test_db, test_user, installed, credential=SecretStr("stale"))
    current = grant(service, test_db, test_user, connection)
    with pytest.raises(PluginAccountAuthError, match="revision_conflict"):
        grant(service, test_db, test_user, connection)
    assert (
        "test-password"
        in read(service, test_db, test_user, installed, current).get_secret_value()
    )


def test_revoke_and_disconnect_invalidate_reads(
    service, test_db, test_user, installed, device
):
    connection = grant(
        service, test_db, test_user, enroll(service, test_db, test_user, installed)
    )
    revoked = service.revoke_device(
        test_db,
        user_id=test_user.id,
        connection_id=connection.id,
        device_id=device.name,
        expected_revision=connection.revision,
    )
    with pytest.raises(PluginAccountAuthError, match="revision_conflict"):
        read(service, test_db, test_user, installed, connection)
    with pytest.raises(PluginAccountAuthError, match="device_not_granted"):
        read(service, test_db, test_user, installed, revoked)
    connected = grant(service, test_db, test_user, revoked)
    disconnected = service.disconnect(
        test_db,
        user_id=test_user.id,
        connection_id=connected.id,
        expected_revision=connected.revision,
    )
    with pytest.raises(PluginAccountAuthError, match="disconnected"):
        read(service, test_db, test_user, installed, disconnected)
    row = test_db.query(Kind).filter(Kind.name == connected.id).one()
    assert row.json["spec"]["credential"] is None
    assert disconnected.device_ids == []


def test_recreated_runtime_does_not_inherit_grant(
    service, test_db, test_user, installed, device
):
    connection = grant(
        service, test_db, test_user, enroll(service, test_db, test_user, installed)
    )
    data = deepcopy(device.json)
    data["spec"]["runtimeInstanceId"] = "instance-2"
    device.json = data
    test_db.flush()
    with pytest.raises(PluginAccountAuthError, match="device_not_granted"):
        read(service, test_db, test_user, installed, connection)


@pytest.mark.parametrize("change", ["source", "adapter", "disabled", "uninstalled"])
def test_plugin_replacement_cannot_inherit_credentials(
    change, service, test_db, test_user, installed, device
):
    connection = grant(
        service, test_db, test_user, enroll(service, test_db, test_user, installed)
    )
    data = deepcopy(installed.json)
    if change == "source":
        data["spec"]["source"]["catalogItemId"] = "attacker-plugin"
    elif change == "adapter":
        data["spec"]["components"]["connectors"][0]["accountAuth"][
            "adapter"
        ] = "scripts/other.py"
    elif change == "disabled":
        data["spec"]["enabled"] = False
    else:
        installed.is_active = False
    installed.json = data
    test_db.flush()
    with pytest.raises(PluginAccountAuthError):
        read(service, test_db, test_user, installed, connection)


def test_separate_accounts_and_ciphertext_swap_rejected(
    service, test_db, test_user, installed, device
):
    first = grant(
        service, test_db, test_user, enroll(service, test_db, test_user, installed)
    )
    second = grant(
        service,
        test_db,
        test_user,
        enroll(service, test_db, test_user, installed, account_id="account-2"),
    )
    assert first.id != second.id
    rows = {
        r.name: r
        for r in test_db.query(Kind)
        .filter(Kind.namespace == CONNECTION_NAMESPACE)
        .all()
    }
    data = deepcopy(rows[first.id].json)
    data["spec"]["credential"] = rows[second.id].json["spec"]["credential"]
    rows[first.id].json = data
    test_db.flush()
    with pytest.raises(PluginCredentialCipherError):
        read(service, test_db, test_user, installed, first)


def test_deleted_device_can_still_be_revoked(
    service, test_db, test_user, installed, device
):
    connection = grant(
        service, test_db, test_user, enroll(service, test_db, test_user, installed)
    )
    device.is_active = False
    test_db.flush()
    result = service.revoke_device(
        test_db,
        user_id=test_user.id,
        connection_id=connection.id,
        device_id=device.name,
        expected_revision=connection.revision,
    )
    assert result.device_ids == []


def test_missing_keyring_does_not_break_listing(monkeypatch, test_db, test_user):
    monkeypatch.setattr(settings, "WEWORK_PLUGIN_CREDENTIAL_KEYS", SecretStr(""))
    monkeypatch.setattr(settings, "WEWORK_PLUGIN_CREDENTIAL_ACTIVE_KEY_ID", "")
    assert (
        PluginAccountConnectionService().list_connections(test_db, user_id=test_user.id)
        == []
    )


@pytest.fixture
def migrations(service):
    from app.services.plugin_auth_migrations import PluginAuthMigrationService

    return PluginAuthMigrationService(service)


def migration_request(installed, device):
    from app.schemas.plugin_account_auth import PluginMigrationCreate

    return PluginMigrationCreate(
        installed_plugin_id=installed.id,
        connector_slug="mail",
        device_id=device.name,
        expected_revision=0,
    )


def set_local_device(test_db, device):
    value = deepcopy(device.json)
    value["spec"]["deviceType"] = "local"
    device.json = value
    test_db.flush()


def native_enrollment(ticket):
    from app.schemas.plugin_account_auth import PluginNativeEnrollment

    return PluginNativeEnrollment(
        migration_id=ticket.id,
        account_id="account-1",
        credential=SecretStr('{"username":"alice","password":"synthetic-secret"}'),
    )


def test_migration_requires_local_device(
    migrations, test_db, test_user, installed, device
):
    with pytest.raises(PluginAccountAuthError, match="local_device_required"):
        migrations.create(
            test_db, user_id=test_user.id, request=migration_request(installed, device)
        )


def test_migration_is_single_use_and_grants_only_source_device(
    migrations, service, test_db, test_user, installed, device
):
    set_local_device(test_db, device)
    ticket = migrations.create(
        test_db, user_id=test_user.id, request=migration_request(installed, device)
    )
    connection = migrations.consume(
        test_db,
        user_id=test_user.id,
        device_id=device.name,
        request=native_enrollment(ticket),
    )
    assert connection.device_ids == [device.name]
    assert "synthetic-secret" not in connection.model_dump_json()
    assert (
        "synthetic-secret"
        in read(service, test_db, test_user, installed, connection).get_secret_value()
    )
    with pytest.raises(PluginAccountAuthError, match="migration_expired"):
        migrations.consume(
            test_db,
            user_id=test_user.id,
            device_id=device.name,
            request=native_enrollment(ticket),
        )


@pytest.mark.parametrize("mutation", ["instance", "source", "adapter", "expiry"])
def test_migration_rejects_changed_bindings(
    migrations, test_db, test_user, installed, device, mutation, monkeypatch
):
    set_local_device(test_db, device)
    ticket = migrations.create(
        test_db, user_id=test_user.id, request=migration_request(installed, device)
    )
    if mutation == "instance":
        value = deepcopy(device.json)
        value["spec"]["runtimeInstanceId"] = "replacement"
        device.json = value
    elif mutation in {"source", "adapter"}:
        value = deepcopy(installed.json)
        if mutation == "source":
            value["spec"]["source"]["providerKey"] = "other"
        else:
            value["spec"]["components"]["connectors"][0]["accountAuth"][
                "adapter"
            ] = "scripts/changed.py"
        installed.json = value
    else:
        monkeypatch.setattr(
            "app.services.plugin_auth_migrations.time.time", lambda: ticket.expires_at
        )
    test_db.flush()
    with pytest.raises(PluginAccountAuthError):
        migrations.consume(
            test_db,
            user_id=test_user.id,
            device_id=device.name,
            request=native_enrollment(ticket),
        )


@pytest.mark.parametrize(
    "credential",
    [
        "not-json",
        "[]",
        "{}",
        '{"username":"alice","password":"x","password":"y"}',
        '{"username":"alice","password":"x","extra":NaN}',
    ],
)
def test_invalid_native_credentials_do_not_consume_migration(
    migrations, test_db, test_user, installed, device, credential
):
    set_local_device(test_db, device)
    ticket = migrations.create(
        test_db, user_id=test_user.id, request=migration_request(installed, device)
    )
    request = native_enrollment(ticket).model_copy(
        update={"credential": SecretStr(credential)}
    )
    with pytest.raises(PluginAccountAuthError, match="invalid_credential"):
        migrations.consume(
            test_db, user_id=test_user.id, device_id=device.name, request=request
        )
    result = migrations.consume(
        test_db,
        user_id=test_user.id,
        device_id=device.name,
        request=native_enrollment(ticket),
    )
    assert result.status == "connected"


def test_migration_cannot_be_consumed_by_another_user(
    migrations, test_db, test_user, installed, device
):
    set_local_device(test_db, device)
    ticket = migrations.create(
        test_db, user_id=test_user.id, request=migration_request(installed, device)
    )
    with pytest.raises(PluginAccountAuthError, match="migration_expired"):
        migrations.consume(
            test_db,
            user_id=test_user.id + 1000,
            device_id=device.name,
            request=native_enrollment(ticket),
        )


@pytest.mark.asyncio
async def test_native_broker_enroll_read_and_revoke_against_database(
    migrations, service, test_db, test_user, installed, device, monkeypatch
):
    from contextlib import contextmanager
    from types import SimpleNamespace
    from unittest.mock import AsyncMock

    from app.api.ws import plugin_auth_broker as broker

    set_local_device(test_db, device)
    ticket = migrations.create(
        test_db, user_id=test_user.id, request=migration_request(installed, device)
    )

    @contextmanager
    def session_factory():
        yield test_db

    monkeypatch.setattr(broker, "SessionLocal", session_factory)
    monkeypatch.setattr(broker, "plugin_auth_migrations", migrations)
    monkeypatch.setattr(broker, "plugin_account_connection_service", service)
    monkeypatch.setattr(
        broker.runtime_route_resolver,
        "resolve",
        AsyncMock(
            return_value=SimpleNamespace(
                socket_id="native-socket",
                runtime_device_id="runtime-device",
                runtime_instance_id="instance-1",
            )
        ),
    )
    session = {
        "user_id": test_user.id,
        "execution_target_id": device.name,
        "device_id": "runtime-device",
        "runtime_instance_id": "instance-1",
    }
    response = await broker.exchange(
        sid="native-socket",
        session=session,
        operation="enroll",
        data={
            "migration_id": ticket.id,
            "account_id": "account-1",
            "credential": '{"username":"alice","password":"synthetic-secret"}',
        },
    )
    assert response["success"] is True
    assert "synthetic-secret" not in json.dumps(response)
    connection = response["connection"]
    read_request = {
        "connection_id": connection["id"],
        "installed_plugin_id": installed.id,
        "expected_revision": connection["revision"],
    }
    result = await broker.exchange(
        sid="native-socket", session=session, operation="read", data=read_request
    )
    assert result["success"] is True
    assert json.loads(result["credential"])["password"] == "synthetic-secret"
    revoked = service.revoke_device(
        test_db,
        user_id=test_user.id,
        connection_id=connection["id"],
        device_id=device.name,
        expected_revision=connection["revision"],
    )
    result = await broker.exchange(
        sid="native-socket",
        session=session,
        operation="read",
        data={**read_request, "expected_revision": revoked.revision},
    )
    assert result == {"success": False, "error": "plugin_auth_device_not_granted"}


def test_prepare_returns_authoritative_package_without_consuming_intent(
    migrations, test_db, test_user, installed, device
):
    set_local_device(test_db, device)
    value = deepcopy(installed.json)
    value["spec"]["packageRef"] = {"checksum": "sha256:" + "a" * 64}
    installed.json = value
    test_db.flush()
    ticket = migrations.create(
        test_db, user_id=test_user.id, request=migration_request(installed, device)
    )
    prepared = migrations.prepare(
        test_db, user_id=test_user.id, device_id=device.name, migration_id=ticket.id
    )
    assert prepared["operation"] == "export"
    assert prepared["package"] == {
        "installed_plugin_id": installed.id,
        "connector_slug": "mail",
        "checksum": "sha256:" + "a" * 64,
        "auth_definition": {
            "protocolVersion": 1,
            "credentialType": "password",
            "adapter": "scripts/account-auth.py",
        },
    }
    connection = migrations.consume(
        test_db,
        user_id=test_user.id,
        device_id=device.name,
        request=native_enrollment(ticket),
    )
    assert connection.status == "connected"
    with pytest.raises(PluginAccountAuthError, match="migration_expired"):
        migrations.prepare(
            test_db, user_id=test_user.id, device_id=device.name, migration_id=ticket.id
        )


def test_prepare_requires_a_versioned_package(
    migrations, test_db, test_user, installed, device
):
    set_local_device(test_db, device)
    ticket = migrations.create(
        test_db, user_id=test_user.id, request=migration_request(installed, device)
    )
    with pytest.raises(PluginAccountAuthError, match="package_sync_required"):
        migrations.prepare(
            test_db, user_id=test_user.id, device_id=device.name, migration_id=ticket.id
        )


def test_native_business_execution_requires_current_explicit_device_grant(
    service, test_db, test_user, installed, device
):
    from app.schemas.plugin_account_auth import PluginNativeExecution
    from app.services.plugin_auth_execution import PluginAuthExecutionService

    value = deepcopy(installed.json)
    value["spec"]["packageRef"] = {"checksum": "sha256:" + "a" * 64}
    installed.json = value
    test_db.flush()
    execution = PluginAuthExecutionService(service)
    request = PluginNativeExecution(
        installed_plugin_id=installed.id, connector_slug="mail"
    )
    connection = enroll(service, test_db, test_user, installed)

    def prepare():
        return execution.prepare(
            test_db, user_id=test_user.id, device_id=device.name, request=request
        )

    with pytest.raises(PluginAccountAuthError, match="device_not_granted"):
        prepare()
    connection = grant(service, test_db, test_user, connection)
    result = prepare()
    assert json.loads(result["credential"])["password"] == "test-password"
    assert result["package"]["installed_plugin_id"] == installed.id
    assert "credential" not in result["package"]
    service.revoke_device(
        test_db,
        user_id=test_user.id,
        connection_id=connection.id,
        device_id=device.name,
        expected_revision=connection.revision,
    )
    with pytest.raises(PluginAccountAuthError, match="device_not_granted"):
        prepare()


def test_native_business_execution_requires_selection_for_multiple_accounts(
    service, test_db, test_user, installed, device
):
    from app.schemas.plugin_account_auth import PluginNativeExecution
    from app.services.plugin_auth_execution import PluginAuthExecutionService

    value = deepcopy(installed.json)
    value["spec"]["packageRef"] = {"checksum": "sha256:" + "a" * 64}
    installed.json = value
    test_db.flush()
    for account in ("account-1", "account-2"):
        grant(
            service,
            test_db,
            test_user,
            enroll(service, test_db, test_user, installed, account_id=account),
        )
    execution = PluginAuthExecutionService(service)
    request = PluginNativeExecution(
        installed_plugin_id=installed.id, connector_slug="mail"
    )
    with pytest.raises(PluginAccountAuthError, match="account_selection_required"):
        execution.prepare(
            test_db, user_id=test_user.id, device_id=device.name, request=request
        )
    result = execution.prepare(
        test_db,
        user_id=test_user.id,
        device_id=device.name,
        request=request.model_copy(update={"account_id": "account-2"}),
    )
    assert result["package"]["connector_slug"] == "mail"


def test_authentication_update_is_bound_to_the_selected_account(
    migrations, service, test_db, test_user, installed, device
):
    from app.schemas.plugin_account_auth import PluginMigrationCreate

    set_local_device(test_db, device)
    connection = enroll(service, test_db, test_user, installed)
    request = PluginMigrationCreate(
        installed_plugin_id=installed.id,
        connector_slug="mail",
        device_id=device.name,
        expected_revision=connection.revision,
        expected_account_id=connection.account_id,
    )
    ticket = migrations.create(test_db, user_id=test_user.id, request=request)
    wrong = native_enrollment(ticket).model_copy(
        update={"account_id": "different-account"}
    )
    with pytest.raises(PluginAccountAuthError, match="account_mismatch"):
        migrations.consume(
            test_db, user_id=test_user.id, device_id=device.name, request=wrong
        )
    updated = migrations.consume(
        test_db,
        user_id=test_user.id,
        device_id=device.name,
        request=native_enrollment(ticket),
    )
    assert updated.id == connection.id
    assert updated.account_id == connection.account_id
