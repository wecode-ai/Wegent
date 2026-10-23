# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Runtime task bindings use the identity of the user's owned device."""

from datetime import datetime, timedelta

import pytest
from sqlalchemy.orm import Session

from app.models.delivery import CloudProject, LoopItem, LoopItemTaskBinding
from app.models.kind import Kind
from app.models.user import User
from app.schemas.delivery import LoopItemTaskBind
from app.services.loop_items.service import loop_item_service
from tests.utils.collaboration import authorize_project


@pytest.fixture
def issue_device(test_db: Session, test_user: User) -> tuple[LoopItem, Kind]:
    project = CloudProject(
        public_id="binding-project",
        project_key="BINDING",
        name="Binding project",
        created_by_user_id=test_user.id,
        metadata_json={},
    )
    authorize_project(test_db, project)
    issue = LoopItem(
        id="binding-issue",
        cloud_project_id=project.id,
        title="Bound issue",
        created_by_user_id=test_user.id,
        status="inbox",
        metadata_json={},
    )
    device = Kind(
        kind="Device",
        name="logical-device",
        namespace="default",
        user_id=test_user.id,
        is_active=True,
        json={
            "spec": {
                "deviceType": "app",
                "deviceId": "runtime-device",
                "appDeviceId": "electron-device",
            }
        },
    )
    test_db.add_all([issue, device])
    test_db.commit()
    return issue, device


def _bind(
    db: Session, issue: LoopItem, user: User, device_id: str
) -> LoopItemTaskBinding:
    return loop_item_service.bind_task(
        db,
        issue.id,
        LoopItemTaskBind(
            deviceId=device_id, taskId="runtime-task", taskTitle="Updated task"
        ),
        user.id,
    )


@pytest.mark.parametrize(
    ("first_alias", "second_alias"),
    [
        ("logical-device", "record"),
        ("electron-device", "record"),
        ("record", "electron-device"),
    ],
)
def test_binding_reuses_one_owned_device_across_aliases(
    test_db: Session,
    test_user: User,
    issue_device: tuple[LoopItem, Kind],
    first_alias: str,
    second_alias: str,
) -> None:
    issue, device = issue_device
    aliases = {"record": f"app-record-{device.id}"}
    first = _bind(test_db, issue, test_user, aliases.get(first_alias, first_alias))

    second = _bind(test_db, issue, test_user, aliases.get(second_alias, second_alias))

    assert second.id == first.id
    assert second.device_id == aliases.get(first_alias, first_alias)
    exact = (
        test_db.query(LoopItemTaskBinding)
        .filter_by(
            task_user_id=test_user.id,
            device_id=aliases.get(first_alias, first_alias),
            task_id="runtime-task",
        )
        .one()
    )
    assert exact.id == first.id
    assert loop_item_service.list_task_bindings(test_db, issue.id, test_user.id) == [
        first
    ]


def test_project_binding_preserves_its_original_runtime_address(
    test_db: Session, test_user: User, issue_device: tuple[LoopItem, Kind]
) -> None:
    issue, device = issue_device
    first = loop_item_service.bind_project_task(
        test_db,
        issue.cloud_project_id,
        LoopItemTaskBind(deviceId="electron-device", taskId="runtime-task"),
        test_user.id,
    )
    record_id = f"app-record-{device.id}"

    second = loop_item_service.bind_project_task(
        test_db,
        issue.cloud_project_id,
        LoopItemTaskBind(deviceId=record_id, taskId="runtime-task"),
        test_user.id,
    )

    assert second.id == first.id
    assert second.device_id == "electron-device"
    assert (
        test_db.query(LoopItemTaskBinding)
        .filter_by(
            task_user_id=test_user.id,
            device_id="electron-device",
            task_id="runtime-task",
        )
        .one()
        .id
    ) == first.id


@pytest.mark.parametrize("stored_alias", ["electron-device", "record"])
@pytest.mark.parametrize("operation", ["find", "unbind", "unbind_context"])
@pytest.mark.parametrize("use_original_alias", [False, True])
def test_rebound_session_can_be_found_and_unbound_from_either_alias(
    test_db: Session,
    test_user: User,
    issue_device: tuple[LoopItem, Kind],
    stored_alias: str,
    operation: str,
    use_original_alias: bool,
) -> None:
    issue, device = issue_device
    record_id = f"app-record-{device.id}"
    original_id, requested_id = (
        (record_id, "electron-device")
        if stored_alias == "record"
        else ("electron-device", record_id)
    )
    _bind(test_db, issue, test_user, original_id)
    _bind(test_db, issue, test_user, requested_id)
    lookup_id = original_id if use_original_alias else requested_id
    address = LoopItemTaskBind(deviceId=lookup_id, taskId="runtime-task")

    if operation == "find":
        found = loop_item_service.find_for_runtime_task(
            test_db, test_user.id, lookup_id, "runtime-task"
        )
        assert found.id == issue.id
    else:
        if operation == "unbind":
            loop_item_service.unbind_task(test_db, issue.id, address, test_user.id)
        else:
            loop_item_service.unbind_cloud_context(test_db, address, test_user.id)
        assert (
            loop_item_service.list_task_bindings(test_db, issue.id, test_user.id) == []
        )


def test_binding_keeps_different_owned_devices_separate(
    test_db: Session, test_user: User, issue_device: tuple[LoopItem, Kind]
) -> None:
    issue, device = issue_device
    other = Kind(
        kind="Device",
        name="other-device",
        namespace="default",
        user_id=test_user.id,
        is_active=True,
        json={"spec": {"deviceType": "app", "appDeviceId": "other-electron"}},
    )
    test_db.add(other)
    test_db.commit()
    first = _bind(test_db, issue, test_user, f"app-record-{device.id}")

    second = _bind(test_db, issue, test_user, f"app-record-{other.id}")

    assert second.id != first.id
    assert (
        len(loop_item_service.list_task_bindings(test_db, issue.id, test_user.id)) == 2
    )
    loop_item_service.unbind_task(
        test_db,
        issue.id,
        LoopItemTaskBind(deviceId="electron-device", taskId="runtime-task"),
        test_user.id,
    )
    assert loop_item_service.list_task_bindings(test_db, issue.id, test_user.id) == [
        second
    ]


def test_binding_does_not_reuse_another_users_matching_alias(
    test_db: Session,
    test_user: User,
    test_admin_user: User,
    issue_device: tuple[LoopItem, Kind],
) -> None:
    issue, device = issue_device
    other_device = Kind(
        kind="Device",
        name=device.name,
        namespace="default",
        user_id=test_admin_user.id,
        is_active=True,
        json=device.json,
    )
    other_binding = LoopItemTaskBinding(
        cloud_project_id=issue.cloud_project_id,
        loop_item_id=issue.id,
        task_user_id=test_admin_user.id,
        device_id="logical-device",
        task_id="runtime-task",
        linked_by_user_id=test_admin_user.id,
        linked_at=datetime(2026, 10, 15),
    )
    test_db.add_all([other_device, other_binding])
    test_db.commit()

    binding = _bind(test_db, issue, test_user, f"app-record-{device.id}")

    assert binding.id != other_binding.id
    assert binding.task_user_id == test_user.id
    assert other_binding.task_user_id == test_admin_user.id
    loop_item_service.unbind_task(
        test_db,
        issue.id,
        LoopItemTaskBind(deviceId="electron-device", taskId="runtime-task"),
        test_user.id,
    )
    assert loop_item_service.list_task_bindings(test_db, issue.id, test_user.id) == [
        other_binding
    ]


def test_binding_does_not_merge_an_ambiguous_installation_alias(
    test_db: Session, test_user: User, issue_device: tuple[LoopItem, Kind]
) -> None:
    issue, device = issue_device
    other_installation = Kind(
        kind="Device",
        name=device.name,
        namespace="default",
        user_id=test_user.id,
        is_active=True,
        json={
            "spec": {
                "deviceType": "app",
                "deviceId": "runtime-device",
                "appDeviceId": "other-electron",
            }
        },
    )
    test_db.add(other_installation)
    test_db.commit()
    legacy_binding = _bind(test_db, issue, test_user, "logical-device")

    binding = _bind(test_db, issue, test_user, f"app-record-{device.id}")

    assert binding.id != legacy_binding.id
    assert binding.device_id == f"app-record-{device.id}"
    assert (
        len(loop_item_service.list_task_bindings(test_db, issue.id, test_user.id)) == 2
    )
    loop_item_service.unbind_task(
        test_db,
        issue.id,
        LoopItemTaskBind(deviceId=f"app-record-{device.id}", taskId="runtime-task"),
        test_user.id,
    )
    assert loop_item_service.list_task_bindings(test_db, issue.id, test_user.id) == [
        legacy_binding
    ]


def test_binding_reuses_newest_active_record_for_one_device(
    test_db: Session, test_user: User, issue_device: tuple[LoopItem, Kind]
) -> None:
    issue, device = issue_device
    linked_at = datetime(2026, 10, 15)
    bindings = [
        LoopItemTaskBinding(
            cloud_project_id=issue.cloud_project_id,
            loop_item_id=issue.id,
            task_user_id=test_user.id,
            device_id=alias,
            task_id="runtime-task",
            linked_by_user_id=test_user.id,
            linked_at=linked_at + timedelta(seconds=offset),
        )
        for alias, offset in [("logical-device", 0), ("electron-device", 1)]
    ]
    test_db.add_all(bindings)
    test_db.commit()

    binding = _bind(test_db, issue, test_user, f"app-record-{device.id}")

    assert binding.id == bindings[1].id
    assert test_db.query(LoopItemTaskBinding).count() == 2


@pytest.mark.parametrize("operation", ["unbind", "unbind_context", "rebind"])
def test_duplicate_alias_bindings_are_all_disconnected_or_moved(
    test_db: Session,
    test_user: User,
    issue_device: tuple[LoopItem, Kind],
    operation: str,
) -> None:
    issue, device = issue_device
    aliases = ["electron-device", f"app-record-{device.id}"]
    for alias in aliases:
        test_db.add(
            LoopItemTaskBinding(
                cloud_project_id=issue.cloud_project_id,
                loop_item_id=issue.id,
                task_user_id=test_user.id,
                device_id=alias,
                task_id="runtime-task",
                linked_by_user_id=test_user.id,
                linked_at=datetime(2026, 10, 15),
            )
        )
    test_db.commit()
    address = LoopItemTaskBind(deviceId=aliases[1], taskId="runtime-task")

    if operation == "unbind":
        loop_item_service.unbind_task(test_db, issue.id, address, test_user.id)
    elif operation == "unbind_context":
        loop_item_service.unbind_cloud_context(test_db, address, test_user.id)
    else:
        other_issue = LoopItem(
            id="other-binding-issue",
            cloud_project_id=issue.cloud_project_id,
            title="Other issue",
            created_by_user_id=test_user.id,
            status="inbox",
            metadata_json={},
        )
        test_db.add(other_issue)
        test_db.commit()
        moved = _bind(test_db, other_issue, test_user, aliases[1])
        assert moved.loop_item_id == other_issue.id

    assert loop_item_service.list_task_bindings(test_db, issue.id, test_user.id) == []
