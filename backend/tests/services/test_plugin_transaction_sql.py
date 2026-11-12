"""Keep transaction fences while avoiding redundant Kind writes."""

from collections import Counter
from contextlib import contextmanager

import pytest
from sqlalchemy import event

from app.models.kind import Kind
from app.models.plugin_state import PluginState
from app.schemas.installed_plugin import InstalledPluginUpdateRequest
from app.services.device.plugin_sync_protocol import (
    lock_installed_plugin_state,
    lock_plugin_sync_state,
)
from app.services.installed_plugin_service import installed_plugin_service
from app.services.plugin_local_sync import mutate_local_plugin
from app.services.plugin_marketplace_service import plugin_marketplace_service
from app.services.plugin_write_coordination import acquire_plugin_write_lock
from tests.services.test_plugin_marketplace_v2 import _create_marketplace_update_install


@contextmanager
def kind_writes(db):
    """Count actual statements, including writes issued by Session events."""
    writes = Counter()

    def observe(_connection, _cursor, statement, _parameters, context, _many):
        normalized = " ".join(statement.upper().split())
        if _cursor.rowcount == 0 and normalized.startswith("UPDATE"):
            return
        if normalized.startswith(("INSERT INTO PLUGIN_STATES", "UPDATE PLUGIN_STATES")):
            writes[normalized.split()[0], "PluginState"] += 1
            return
        if not normalized.startswith(("INSERT INTO KINDS", "UPDATE KINDS")):
            return
        values = (context.compiled_parameters or [{}])[0]
        kind = next(
            value
            for key, value in values.items()
            if key.startswith("kind") and isinstance(value, str)
        )
        writes[normalized.split()[0], kind] += 1

    connection = db.connection()
    event.listen(connection, "after_cursor_execute", observe)
    try:
        yield writes
    finally:
        event.remove(connection, "after_cursor_execute", observe)


@pytest.fixture
def account_install(test_db, test_user):
    installed, plugin, _current, latest = _create_marketplace_update_install(
        test_db, user_id=test_user.id, index=978
    )
    installed.name = plugin_marketplace_service._kind_name(
        plugin.catalog_namespace, plugin.slug
    )
    test_db.flush()
    lock_installed_plugin_state(test_db, test_user.id, installed.id)
    test_db.commit()
    return installed, plugin, latest


@pytest.mark.parametrize("action", ["update", "uninstall"])
def test_account_mutation_combines_content_and_write_fence(
    test_db, test_user, account_install, action
):
    installed, _plugin, _latest = account_install
    with kind_writes(test_db) as writes:
        if action == "update":
            installed_plugin_service.update_installed_plugin(
                db=test_db,
                user_id=test_user.id,
                installed_id=installed.id,
                request=InstalledPluginUpdateRequest(enabled=True),
            )
        else:
            installed_plugin_service.uninstall_installed_plugin(
                db=test_db, user_id=test_user.id, installed_id=installed.id
            )

    assert writes == {
        ("UPDATE", "InstalledPlugin"): 1,
        ("UPDATE", "PluginState"): 1,
    }
    assert installed.json["spec"]["writeRevision"] == 1
    assert installed.is_active == (action == "update")


@pytest.mark.parametrize("action", ["update", "release", "uninstall"])
def test_local_intent_combines_order_receipt_and_desired_revision(
    test_db, test_user, account_install, monkeypatch, action
):
    monkeypatch.setenv("PLUGIN_LOCAL_SYNC_ENABLED", "true")
    installed, _plugin, latest = account_install
    installed_id = installed.id
    payload = (
        {"releaseId": latest.id}
        if action == "release"
        else {"enabled": True} if action == "update" else None
    )
    options = dict(
        user_id=test_user.id,
        instance_id="sql-client",
        operation_id="sql-operation",
        intent_order=1,
        action="update" if action == "release" else action,
        target_id=installed_id,
        payload=payload,
    )
    with kind_writes(test_db) as writes:
        mutate_local_plugin(test_db, **options)

    assert writes == {
        ("UPDATE", "InstalledPlugin"): 1,
        ("UPDATE", "PluginState"): 1,
    }
    state = lock_installed_plugin_state(test_db, test_user.id, installed_id)
    spec = state.json["spec"]
    assert spec["revision"] == 1
    assert spec["localIntentOrders"]["sql-client"][str(installed_id)] == 1
    receipt = spec["localIntents"]["sql-client"][str(installed_id)]
    assert receipt["operationId"] == "sql-operation"
    parent = test_db.get(Kind, installed_id)
    assert parent.json["spec"]["writeRevision"] == 1
    assert receipt["installedRevision"] == parent.json["spec"]["revision"]

    with kind_writes(test_db) as replay_writes:
        mutate_local_plugin(test_db, **options)
    assert not replay_writes
    test_db.rollback()


@pytest.mark.parametrize("local", [False, True])
@pytest.mark.parametrize("cold", [False, True])
def test_first_install_keeps_creation_cas_without_an_extra_parent_update(
    test_db, test_user, account_install, monkeypatch, local, cold
):
    monkeypatch.setenv("PLUGIN_LOCAL_SYNC_ENABLED", "true")
    installed, plugin, _latest = account_install
    test_db.delete(installed)
    if cold:
        test_db.query(PluginState).filter_by(user_id=test_user.id).delete(
            synchronize_session=False
        )
    else:
        state = lock_installed_plugin_state(test_db, test_user.id, installed.id)
        state.json = {
            "spec": {
                "revision": 0,
                "generation": 11,
                "localIntentOrders": {"historical": {str(installed.id): 9}},
            }
        }
    test_db.commit()

    with kind_writes(test_db) as writes:
        if local:
            result = mutate_local_plugin(
                test_db,
                user_id=test_user.id,
                instance_id="sql-client",
                operation_id="sql-install",
                intent_order=1,
                action="install",
                target_id=plugin.id,
            )
            installed_id = int(result["metadata"]["labels"]["id"])
        else:
            result = plugin_marketplace_service.install(
                test_db, user_id=test_user.id, plugin_id=plugin.id
            )
            installed_id = int(result.metadata["labels"]["id"])

    expected = Counter(
        {("INSERT", "InstalledPlugin"): 1, ("UPDATE", "PluginState"): 1 + local}
    )
    if cold:
        expected["INSERT", "PluginState"] = 1
    assert writes == expected
    assert test_db.get(Kind, installed_id).json["spec"]["writeRevision"] == 1
    state = lock_installed_plugin_state(test_db, test_user.id, installed_id)
    assert state.installed_kind_id == installed_id
    if not cold:
        assert state.json["spec"]["generation"] == 11
        assert state.json["spec"]["localIntentOrders"]["historical"] == {
            str(installed.id): 9
        }
    assert state.json["spec"]["creationRevisions"] == {
        plugin_marketplace_service._kind_name(plugin.catalog_namespace, plugin.slug): 1
    }


def test_orm_content_write_advances_fence_without_a_second_update(
    test_db, test_user, account_install
):
    installed, _plugin, _latest = account_install
    acquire_plugin_write_lock(test_db, test_user.id, installed_id=installed.id)
    installed.json = {
        **installed.json,
        "spec": {**installed.json["spec"], "enabled": True},
    }
    with kind_writes(test_db) as writes:
        test_db.commit()

    assert writes == {
        ("UPDATE", "InstalledPlugin"): 1,
        ("UPDATE", "PluginState"): 1,
    }
    test_db.refresh(installed)
    assert installed.json["spec"]["writeRevision"] == 1
