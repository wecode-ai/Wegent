"""Automatic synchronization stays bounded without reusing a consumed intent ID."""

from copy import deepcopy

import pytest
from pydantic import SecretStr

from app.models.kind import Kind
from app.schemas.plugin_account_auth import PluginNativeEnrollment
from app.services.plugin_account_connections import (
    CONNECTION_NAMESPACE,
    PluginAccountAuthError,
)
from app.services.plugin_auth_migrations import MIGRATION_KIND
from tests.services.test_plugin_account_connections import (
    device,
    installed,
    migration_request,
    service,
)
from tests.services.test_plugin_auth_automation import automation, local, reconcile


def slots(db, user):
    return db.query(Kind).filter(
        Kind.user_id == user.id,
        Kind.kind == MIGRATION_KIND,
        Kind.namespace == CONNECTION_NAMESPACE,
    )


def consume(automation, db, user, intent, password="synthetic"):
    return automation.migrations.consume(
        db,
        user_id=user.id,
        device_id="local",
        request=PluginNativeEnrollment(
            migration_id=intent,
            account_id="alice",
            credential=SecretStr('{"username":"alice","password":"' + password + '"}'),
        ),
    )


def test_repeated_sync_overwrites_one_row_and_rejects_all_old_ids(
    automation, service, test_db, test_user, installed, local
):
    seen = []
    row_id = None
    revision = None
    for index in range(5):
        intent = reconcile(automation, test_db, test_user, installed)["migrations"][0][
            "id"
        ]
        row = slots(test_db, test_user).one()
        row_id = row_id or row.id
        assert row.id == row_id
        assert intent not in seen
        assert (
            reconcile(automation, test_db, test_user, installed)["migrations"][0]["id"]
            == intent
        )
        connection = consume(automation, test_db, test_user, intent)
        revision = revision or connection.revision
        assert connection.revision == revision
        seen.append(intent)
        # Exercise the next round after a committed broker transaction too.
        test_db.commit()
        for previous in seen:
            with pytest.raises(PluginAccountAuthError, match="migration_expired"):
                consume(automation, test_db, test_user, previous)
    latest = reconcile(automation, test_db, test_user, installed)["migrations"][0]["id"]
    changed = consume(automation, test_db, test_user, latest, "new-synthetic")
    assert changed.revision == revision + 2
    row = slots(test_db, test_user).populate_existing().one()
    assert row.id == row_id and row.name == latest and not row.is_active
    for previous in seen:
        with pytest.raises(PluginAccountAuthError, match="migration_expired"):
            automation.migrations.prepare(
                test_db, user_id=test_user.id, device_id="local", migration_id=previous
            )


@pytest.mark.parametrize("change", ["expired", "runtime", "definition", "reinstalled"])
def test_replaced_intent_keeps_row_but_updates_binding_and_plugin_metadata(
    automation, test_db, test_user, installed, local, change
):
    old = reconcile(automation, test_db, test_user, installed)["migrations"][0]["id"]
    row = slots(test_db, test_user).one()
    row_id = row.id
    if change == "expired":
        row.json = {"spec": {**row.json["spec"], "expires_at": 1}}
    elif change == "runtime":
        value = deepcopy(local.json)
        value["spec"]["runtimeInstanceId"] = "replacement"
        local.json = value
    elif change == "definition":
        value = deepcopy(installed.json)
        value["spec"]["components"]["connectors"][0]["accountAuth"][
            "adapter"
        ] = "new.py"
        installed.json = value
    else:
        installed.is_active = False
        replacement = Kind(
            user_id=test_user.id,
            kind="InstalledPlugin",
            namespace="default",
            name=installed.name,
            json=deepcopy(installed.json),
            is_active=True,
        )
        test_db.add(replacement)
        installed = replacement
    test_db.flush()

    renewed = reconcile(automation, test_db, test_user, installed)["migrations"][0][
        "id"
    ]

    current = slots(test_db, test_user).populate_existing().one()
    assert current.id == row_id and renewed != old
    assert current.json["spec"]["installed_plugin_id"] == installed.id
    assert (
        current.json["spec"]["binding"]["runtimeInstanceId"]
        == local.json["spec"]["runtimeInstanceId"]
    )
    assert (
        current.json["spec"]["auth_definition"]
        == installed.json["spec"]["components"]["connectors"][0]["accountAuth"]
    )
    with pytest.raises(PluginAccountAuthError, match="migration_expired"):
        automation.migrations.prepare(
            test_db, user_id=test_user.id, device_id="local", migration_id=old
        )
    assert consume(automation, test_db, test_user, renewed).status == "connected"


def test_automatic_slots_are_separate_for_devices_connectors_and_plugin_sources(
    automation, test_db, test_user, installed, local
):
    other = Kind(
        user_id=test_user.id,
        kind="Device",
        namespace="default",
        name="local-other",
        json={
            "spec": {
                "deviceType": "local",
                "deviceId": "other",
                "runtimeInstanceId": "other",
            }
        },
        is_active=True,
    )
    test_db.add(other)
    value = deepcopy(installed.json)
    connector = deepcopy(value["spec"]["components"]["connectors"][0])
    connector["slug"] = "calendar"
    value["spec"]["components"]["connectors"].append(connector)
    installed.json = value
    second_value = deepcopy(value)
    second_value["spec"]["source"]["pluginKey"] = "mail-other"
    second = Kind(
        user_id=test_user.id,
        kind="InstalledPlugin",
        namespace="default",
        name="mail-other",
        json=second_value,
        is_active=True,
    )
    test_db.add(second)
    test_db.flush()

    for _ in range(3):
        for plugin in (installed, second):
            for device_id in ("local", "local-other"):
                assert (
                    len(
                        reconcile(automation, test_db, test_user, plugin, device_id)[
                            "migrations"
                        ]
                    )
                    == 2
                )

    assert slots(test_db, test_user).count() == 8


def test_failed_enrollment_rolls_back_claim_without_losing_sync_slot(
    automation, test_db, test_user, installed, local, monkeypatch
):
    intent = reconcile(automation, test_db, test_user, installed)["migrations"][0]["id"]
    original = automation.connections.enroll

    def fail(*args, **kwargs):
        raise PluginAccountAuthError("synthetic_failure")

    monkeypatch.setattr(automation.connections, "enroll", fail)
    with pytest.raises(PluginAccountAuthError, match="synthetic_failure"):
        with test_db.begin_nested():
            consume(automation, test_db, test_user, intent)
    monkeypatch.setattr(automation.connections, "enroll", original)

    assert (
        reconcile(automation, test_db, test_user, installed)["migrations"][0]["id"]
        == intent
    )
    assert consume(automation, test_db, test_user, intent).status == "connected"
    assert slots(test_db, test_user).count() == 1


def test_automatic_sync_does_not_supersede_explicit_user_intents(
    automation, test_db, test_user, installed, local
):
    value = deepcopy(installed.json)
    value["spec"]["packageRef"] = {"checksum": "sha256:" + "a" * 64}
    installed.json = value
    test_db.flush()
    manual = automation.migrations.create(
        test_db,
        user_id=test_user.id,
        request=migration_request(installed, local),
    )
    for _ in range(3):
        intent = reconcile(automation, test_db, test_user, installed)["migrations"][0][
            "id"
        ]
        consume(automation, test_db, test_user, intent)

    assert slots(test_db, test_user).count() == 2
    assert (
        automation.migrations._query(test_db, test_user.id, manual.id).one().is_active
    )
    assert (
        automation.migrations.prepare(
            test_db, user_id=test_user.id, device_id="local", migration_id=manual.id
        )["operation"]
        == "export"
    )


def test_automatic_sync_keeps_other_users_rows_untouched(
    automation, test_db, test_user, test_admin_user, installed, local
):
    intent = reconcile(automation, test_db, test_user, installed)["migrations"][0]["id"]
    row = slots(test_db, test_user).one()
    foreign = Kind(
        user_id=test_admin_user.id,
        kind=MIGRATION_KIND,
        namespace=CONNECTION_NAMESPACE,
        name="a" * 64,
        json=deepcopy(row.json),
        is_active=False,
    )
    test_db.add(foreign)
    test_db.flush()
    foreign_json = deepcopy(foreign.json)
    consume(automation, test_db, test_user, intent)

    renewed = reconcile(automation, test_db, test_user, installed)["migrations"][0][
        "id"
    ]

    assert renewed != intent
    assert slots(test_db, test_user).count() == 1
    test_db.refresh(foreign)
    assert foreign.name == "a" * 64 and foreign.json == foreign_json
    assert not foreign.is_active
