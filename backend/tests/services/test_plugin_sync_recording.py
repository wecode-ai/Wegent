# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from contextlib import nullcontext
from copy import deepcopy

import pytest

from app.models.kind import Kind
from app.models.plugin_marketplace import PluginDeviceInstallation
from app.schemas.device import DeviceCapabilitySyncResult
from app.services.device.capability_sync_service import DeviceCapabilitySyncService
from app.services.device.plugin_sync_protocol import (
    lock_plugin_sync_state,
    plugin_snapshot_watermark,
    register_plugin_snapshot_intent,
)
from app.services.plugin_device_installation_service import (
    PluginDeviceInstallationService,
)

pytestmark = pytest.mark.usefixtures("plugin_write_sessions")


def _installed(db, user_id, name, *, active=True, release=17):
    installed = Kind(
        user_id=user_id,
        kind="InstalledPlugin",
        namespace="default",
        name=name,
        is_active=active,
        json={
            "spec": {
                "installState": "installed" if active else "uninstalled",
                "enabled": True,
                "marketplace": "test-marketplace",
                "version": "1.0.0",
                "releaseId": release,
                "packageRef": {"checksum": f"sha256:release-{release}"},
            }
        },
    )
    db.add(installed)
    db.commit()
    return installed


def _device_row(db, installed, *, state="pending", actual=0):
    row = PluginDeviceInstallation(
        installed_kind_id=installed.id,
        user_id=installed.user_id,
        device_id="device",
        desired_release_id=installed.json["spec"]["releaseId"],
        actual_release_id=actual,
        state=state,
    )
    db.add(row)
    db.commit()
    return row


def _payload(db, installed, *, removed=False, complete=False):
    plugin = DeviceCapabilitySyncService()._plugin_payload(db, installed)
    return {
        "mode": "merge",
        "scope": "plugins" if complete else "plugin_delta",
        "plugins": [] if removed else [plugin],
        "removed_plugins": [plugin] if removed else [],
        "plugin_sync": {"version": 2, "generation": 7, "complete": complete},
    }


def _result(payload, *, status="synced", success=True, device_id="device"):
    requested = payload["plugins"] + payload["removed_plugins"]
    return DeviceCapabilitySyncResult(
        device_id=device_id,
        success=success,
        acknowledged=True,
        scope=payload["scope"],
        plugin_sync=payload["plugin_sync"],
        desired_plugin_snapshot=payload,
        plugins=[
            {
                "id": item["installed_plugin_id"],
                "status": status,
                "generation": payload["plugin_sync"]["generation"],
                "operation": "remove" if payload["removed_plugins"] else "upsert",
                "version": item.get("version"),
                "checksum": item.get("checksum"),
                "error": "download failed" if status == "failed" else None,
            }
            for item in requested
        ],
    )


def _record(db, user_id, payload, *, status="synced", success=True):
    PluginDeviceInstallationService().record_device_sync_result(
        db, user_id=user_id, result=_result(payload, status=status, success=success)
    )


def test_delta_ack_does_not_clear_unrelated_pending_uninstall(test_db, test_user):
    installed = _installed(test_db, test_user.id, "target")
    unrelated = _installed(test_db, test_user.id, "unrelated", active=False)
    target_row = _device_row(test_db, installed)
    unrelated_row = _device_row(test_db, unrelated, state="uninstalling", actual=17)

    _record(test_db, test_user.id, _payload(test_db, installed))

    test_db.refresh(target_row)
    test_db.refresh(unrelated_row)
    assert target_row.state == "installed"
    assert target_row.actual_release_id == 17
    assert unrelated_row.state == "uninstalling"
    assert unrelated_row.actual_release_id == 17


@pytest.mark.parametrize("change", ["release", "enabled", "component_states"])
def test_late_install_ack_cannot_confirm_newer_account_desired_state(
    test_db, test_user, change
):
    installed = _installed(test_db, test_user.id, "target")
    row = _device_row(test_db, installed)
    old_payload = _payload(test_db, installed)
    data = deepcopy(installed.json)
    if change == "release":
        data["spec"].update(
            version="2.0.0", releaseId=18, packageRef={"checksum": "sha256:new"}
        )
        row.desired_release_id = 18
    elif change == "enabled":
        data["spec"]["enabled"] = False
    else:
        data["spec"]["componentStates"] = {"skills": {"example": False}}
    installed.json = data
    test_db.commit()

    _record(test_db, test_user.id, old_payload)

    test_db.refresh(row)
    assert row.state == "pending"
    assert row.actual_release_id == 0
    assert row.desired_release_id == (18 if change == "release" else 17)
    assert row.attempt_count == 0


def test_late_remove_ack_cannot_delete_reinstalled_device_row(test_db, test_user):
    installed = _installed(test_db, test_user.id, "target", active=False)
    row = _device_row(test_db, installed, state="uninstalling", actual=17)
    uninstall_payload = _payload(test_db, installed, removed=True)
    installed.is_active = True
    installed.json = {
        **installed.json,
        "spec": {**installed.json["spec"], "installState": "installed"},
    }
    row.state = "pending"
    test_db.commit()

    _record(test_db, test_user.id, uninstall_payload, status="removed")

    test_db.refresh(row)
    assert row.state == "pending"
    assert row.actual_release_id == 17
    assert installed.is_active is True


def test_failed_install_remains_retryable_and_success_clears_failure(
    test_db, test_user
):
    installed = _installed(test_db, test_user.id, "target")
    row = _device_row(test_db, installed)
    payload = _payload(test_db, installed)

    _record(test_db, test_user.id, payload, status="failed", success=False)
    test_db.refresh(row)
    assert row.state == "failed"
    assert row.actual_release_id == 0
    assert row.attempt_count == 1
    assert row.error_message == "download failed"

    _record(test_db, test_user.id, payload)
    test_db.refresh(row)
    assert row.state == "installed"
    assert row.actual_release_id == 17
    assert row.attempt_count == 0
    assert row.error_message == ""


def test_complete_snapshot_only_clears_installs_still_absent_from_account(
    test_db, test_user
):
    target = _installed(test_db, test_user.id, "target")
    inactive = _installed(test_db, test_user.id, "removed", active=False)
    target_row = _device_row(test_db, target)
    removed_row = _device_row(test_db, inactive, state="uninstalling", actual=17)
    removed_id = removed_row.id
    snapshot = _payload(test_db, target, complete=True)
    added_after_snapshot = _installed(test_db, test_user.id, "new-plugin")
    new_row = _device_row(test_db, added_after_snapshot)

    _record(test_db, test_user.id, snapshot)

    test_db.expire_all()
    assert test_db.get(PluginDeviceInstallation, removed_id) is None
    assert test_db.get(PluginDeviceInstallation, target_row.id).state == "installed"
    assert test_db.get(PluginDeviceInstallation, new_row.id).state == "pending"


def test_superseded_ack_does_not_materialize_or_fail_current_desired_state(
    test_db, test_user
):
    installed = _installed(test_db, test_user.id, "target")
    row = _device_row(test_db, installed)

    _record(test_db, test_user.id, _payload(test_db, installed), status="superseded")

    test_db.refresh(row)
    assert row.state == "pending"
    assert row.actual_release_id == 0
    assert row.attempt_count == 0


@pytest.mark.parametrize("newest_succeeded", [False, True])
def test_older_same_package_ack_cannot_overwrite_newer_device_result(
    test_db, test_user, newest_succeeded
):
    installed = _installed(test_db, test_user.id, "target")
    row = _device_row(test_db, installed)
    old_snapshot = _payload(test_db, installed)
    new_snapshot = deepcopy(old_snapshot)
    new_snapshot["plugin_sync"]["generation"] += 1

    _record(
        test_db,
        test_user.id,
        new_snapshot,
        status="synced" if newest_succeeded else "failed",
        success=newest_succeeded,
    )
    _record(
        test_db,
        test_user.id,
        old_snapshot,
        status="failed" if newest_succeeded else "synced",
        success=not newest_succeeded,
    )

    test_db.refresh(row)
    assert row.state == ("installed" if newest_succeeded else "failed")
    assert row.actual_release_id == (17 if newest_succeeded else 0)
    assert row.attempt_count == (0 if newest_succeeded else 1)


@pytest.mark.parametrize("old_status", ["synced", "failed"])
def test_newer_sent_intent_fences_older_ack_before_new_result_arrives(
    test_db, test_user, old_status
):
    installed = _installed(test_db, test_user.id, "target")
    row = _device_row(test_db, installed)
    old_snapshot = _payload(test_db, installed)
    next_snapshot = deepcopy(old_snapshot)
    next_snapshot["plugin_sync"]["generation"] += 1
    register_plugin_snapshot_intent(
        lambda: nullcontext(test_db),
        user_id=test_user.id,
        device_id="device",
        payload=next_snapshot,
    )

    _record(
        test_db,
        test_user.id,
        old_snapshot,
        status=old_status,
        success=old_status == "synced",
    )

    test_db.refresh(row)
    assert row.state == "pending"
    assert row.actual_release_id == 0
    assert row.attempt_count == 0
    _record(test_db, test_user.id, next_snapshot)
    test_db.refresh(row)
    assert row.state == "installed"
    assert row.actual_release_id == 17


def test_newer_other_plugin_intent_does_not_fence_independent_ack(test_db, test_user):
    installed = _installed(test_db, test_user.id, "target")
    other = _installed(test_db, test_user.id, "other")
    row = _device_row(test_db, installed)
    snapshot = _payload(test_db, installed)
    newer_other = _payload(test_db, other)
    newer_other["plugin_sync"]["generation"] += 1
    register_plugin_snapshot_intent(
        lambda: nullcontext(test_db),
        user_id=test_user.id,
        device_id="device",
        payload=newer_other,
    )

    _record(test_db, test_user.id, snapshot)

    test_db.refresh(row)
    assert row.state == "installed"
    assert row.actual_release_id == 17


def test_newer_complete_intent_fences_old_delta_for_unlisted_plugin(test_db, test_user):
    installed = _installed(test_db, test_user.id, "target")
    row = _device_row(test_db, installed)
    old_snapshot = _payload(test_db, installed)
    complete = deepcopy(old_snapshot)
    complete["plugin_sync"].update(generation=8, complete=True)
    complete.update(scope="plugins", plugins=[])
    register_plugin_snapshot_intent(
        lambda: nullcontext(test_db),
        user_id=test_user.id,
        device_id="device",
        payload=complete,
    )

    _record(test_db, test_user.id, old_snapshot)

    test_db.refresh(row)
    assert row.state == "pending"
    assert row.actual_release_id == 0


@pytest.mark.parametrize("state_exists", [False, True])
def test_mixed_batch_keeps_all_device_watermarks_with_autoflush_disabled(
    test_db, test_user, state_exists
):
    installed = _installed(test_db, test_user.id, "target")
    if state_exists:
        lock_plugin_sync_state(test_db, test_user.id)
        test_db.commit()
    first_snapshot = _payload(test_db, installed)
    second_snapshot = deepcopy(first_snapshot)
    second_snapshot["plugin_sync"]["generation"] = 8
    results = [
        DeviceCapabilitySyncResult(device_id="legacy", success=True),
        _result(first_snapshot, device_id="new-a"),
        _result(second_snapshot, device_id="new-b"),
    ]
    response = DeviceCapabilitySyncService()._aggregate_response(
        results, skipped=0, mode="replace"
    )

    PluginDeviceInstallationService().record_sync_response(
        test_db, user_id=test_user.id, response=response
    )

    state = lock_plugin_sync_state(test_db, test_user.id)
    assert plugin_snapshot_watermark(state, "new-a", installed.id) == 7
    assert plugin_snapshot_watermark(state, "new-b", installed.id) == 8
    assert state.json["spec"]["generation"] == 8
    for device_id in ("new-a", "new-b"):
        row = (
            test_db.query(PluginDeviceInstallation).filter_by(device_id=device_id).one()
        )
        assert row.state == "installed"
        assert row.actual_release_id == 17
