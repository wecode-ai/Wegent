"""Local UI logout fences enrollment; only a fresh login can reconnect."""

from copy import deepcopy

import pytest
from pydantic import SecretStr

from app.schemas.plugin_account_auth import (
    PluginNativeEnrollment,
    PluginNativeLocalLifecycle,
)
from app.services.plugin_account_connections import PluginAccountAuthError
from app.services.plugin_auth_automation import PluginAuthAutomationService
from app.services.plugin_auth_local_lifecycle import PluginAuthLocalLifecycleService
from tests.services.test_plugin_account_connections import device, installed, service
from tests.services.test_plugin_auth_automation import local


@pytest.fixture
def lifecycle(service, installed, test_db):
    payload = deepcopy(installed.json)
    payload["spec"]["components"]["connectors"][0]["localAuth"] = {
        "kind": "browser_oauth",
        "health": ["auth.py", "health"],
        "start": ["auth.py", "login"],
    }
    installed.json = payload
    test_db.flush()
    return PluginAuthLocalLifecycleService(service)


def call(lifecycle, db, user, plugin, action, device_id="local"):
    return lifecycle.exchange(
        db,
        user_id=user.id,
        device_id=device_id,
        request=PluginNativeLocalLifecycle(
            installed_plugin_id=plugin.id, connector_slug="mail", action=action
        ),
    )


def reconcile(lifecycle, db, user, plugin):
    return PluginAuthAutomationService(lifecycle.connections).reconcile(
        db, user_id=user.id, device_id="local", installed_ids=[plugin.id]
    )["migrations"]


def consume(lifecycle, db, user, intent, password="synthetic"):
    return lifecycle.migrations.consume(
        db,
        user_id=user.id,
        device_id="local",
        request=PluginNativeEnrollment(
            migration_id=intent,
            account_id="alice",
            credential=SecretStr('{"username":"alice","password":"' + password + '"}'),
        ),
    )


def test_logout_before_first_enrollment_fences_inflight_and_future_exports(
    lifecycle,
    test_db,
    test_user,
    installed,
    local,
):
    assert call(lifecycle, test_db, test_user, installed, "status") == {"status": None}
    intent = reconcile(lifecycle, test_db, test_user, installed)[0]["id"]
    assert call(lifecycle, test_db, test_user, installed, "logout") == {"status": "ok"}
    with pytest.raises(PluginAccountAuthError, match="migration_expired"):
        consume(lifecycle, test_db, test_user, intent)
    assert reconcile(lifecycle, test_db, test_user, installed) == []
    assert call(lifecycle, test_db, test_user, installed, "status") == {
        "status": "need_login"
    }


def test_managed_status_logout_and_fresh_login_share_existing_connection_service(
    lifecycle,
    test_db,
    test_user,
    installed,
    local,
):
    first = consume(
        lifecycle,
        test_db,
        test_user,
        reconcile(lifecycle, test_db, test_user, installed)[0]["id"],
    )
    assert call(lifecycle, test_db, test_user, installed, "status") == {"status": "ok"}
    call(lifecycle, test_db, test_user, installed, "logout")
    assert (
        lifecycle.connections._get(test_db, test_user.id, first.id).json["spec"][
            "credential"
        ]
        is None
    )
    assert reconcile(lifecycle, test_db, test_user, installed) == []
    call(lifecycle, test_db, test_user, installed, "login")
    intent = reconcile(lifecycle, test_db, test_user, installed)[0]["id"]
    call(lifecycle, test_db, test_user, installed, "login")
    assert reconcile(lifecycle, test_db, test_user, installed)[0]["id"] == intent
    second = consume(lifecycle, test_db, test_user, intent, "new-synthetic")
    assert second.id == first.id
    assert second.status == "connected"
    assert call(lifecycle, test_db, test_user, installed, "status") == {"status": "ok"}


def test_remote_device_cannot_claim_local_login_or_logout(
    lifecycle,
    test_db,
    test_user,
    installed,
    device,
):
    for action in ("status", "login", "logout"):
        with pytest.raises(PluginAccountAuthError, match="local_device_required"):
            call(lifecycle, test_db, test_user, installed, action, "logical-device")


def test_replaced_runtime_does_not_report_old_grant_as_healthy(
    lifecycle,
    test_db,
    test_user,
    installed,
    local,
):
    consume(
        lifecycle,
        test_db,
        test_user,
        reconcile(lifecycle, test_db, test_user, installed)[0]["id"],
    )
    changed = deepcopy(local.json)
    changed["spec"]["runtimeInstanceId"] = "replacement"
    local.json = changed
    test_db.flush()
    assert call(lifecycle, test_db, test_user, installed, "status") == {
        "status": "need_login"
    }


def test_exclusive_logout_waits_for_detach_then_uses_existing_revoke_queue(
    lifecycle,
    test_db,
    test_user,
    installed,
    local,
):
    from app.services.plugin_auth_transfers import PluginAuthTransferService

    value = deepcopy(installed.json)
    value["spec"]["packageRef"] = {"checksum": "sha256:" + "a" * 64}
    value["spec"]["components"]["connectors"][0]["accountAuth"].update(
        credentialType="oauth2", oauth2=["refresh", "revoke"], exportMode="exclusive"
    )
    installed.json = value
    test_db.flush()
    intent = reconcile(lifecycle, test_db, test_user, installed)[0]["id"]
    transfers = PluginAuthTransferService(lifecycle.connections)
    transfers.stage(
        test_db,
        user_id=test_user.id,
        device_id="local",
        request=PluginNativeEnrollment(
            migration_id=intent,
            account_id="alice",
            credential=SecretStr(
                '{"access_token":"synthetic-access","refresh_token":"synthetic-refresh","expires_at":4000000000}'
            ),
        ),
    )
    with pytest.raises(PluginAccountAuthError, match="transfer_pending"):
        call(lifecycle, test_db, test_user, installed, "logout")
    assert (
        transfers.prepare(
            test_db, user_id=test_user.id, device_id="local", migration_id=intent
        )["state"]
        == "staged"
    )
    connection = transfers.finish(
        test_db, user_id=test_user.id, device_id="local", migration_id=intent
    )
    call(lifecycle, test_db, test_user, installed, "logout")
    spec = lifecycle.connections._get(test_db, test_user.id, connection.id).json["spec"]
    assert spec["credential"] is None and spec["deviceGrants"] == {}
    assert spec["oauthRevocation"]["state"] == "pending"
    assert reconcile(lifecycle, test_db, test_user, installed) == []
    call(lifecycle, test_db, test_user, installed, "logout")
    assert (
        lifecycle.connections._get(test_db, test_user.id, connection.id).json["spec"][
            "oauthRevocation"
        ]
        == spec["oauthRevocation"]
    )


def test_same_password_can_reconnect_only_after_explicit_successful_login(
    lifecycle,
    test_db,
    test_user,
    installed,
    local,
):
    consume(
        lifecycle,
        test_db,
        test_user,
        reconcile(lifecycle, test_db, test_user, installed)[0]["id"],
    )
    call(lifecycle, test_db, test_user, installed, "logout")
    call(lifecycle, test_db, test_user, installed, "login")
    connection = consume(
        lifecycle,
        test_db,
        test_user,
        reconcile(lifecycle, test_db, test_user, installed)[0]["id"],
    )
    assert connection.status == "connected"


def test_native_lifecycle_request_cannot_override_identity_or_supply_credentials():
    from pydantic import ValidationError

    for extra in (
        {"user_id": 1},
        {"device_id": "other"},
        {"credential": "synthetic"},
        {"action": "refresh"},
    ):
        with pytest.raises(ValidationError):
            PluginNativeLocalLifecycle.model_validate(
                {
                    "installed_plugin_id": 1,
                    "connector_slug": "mail",
                    "action": "logout",
                    **extra,
                }
            )


def test_fresh_login_survives_expired_sync_intent_and_is_cleared_after_enrollment(
    lifecycle,
    test_db,
    test_user,
    installed,
    local,
):
    from app.services.plugin_auth_local_lifecycle import policy_query

    consume(
        lifecycle,
        test_db,
        test_user,
        reconcile(lifecycle, test_db, test_user, installed)[0]["id"],
    )
    call(lifecycle, test_db, test_user, installed, "logout")
    call(lifecycle, test_db, test_user, installed, "login")
    old = reconcile(lifecycle, test_db, test_user, installed)[0]["id"]
    row = lifecycle.migrations._query(test_db, test_user.id, old).first()
    row.json = {"spec": {**row.json["spec"], "expires_at": 1}}
    test_db.flush()
    renewed = reconcile(lifecycle, test_db, test_user, installed)[0]["id"]
    assert renewed != old
    assert consume(lifecycle, test_db, test_user, renewed).status == "connected"
    source = lifecycle.connections._source_identity(installed.json["spec"]["source"])
    assert (
        policy_query(test_db, test_user.id, source, "mail")
        .first()
        .json["spec"]["pendingLogins"]
        == {}
    )
