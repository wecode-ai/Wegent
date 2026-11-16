# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Archive commits before stopping owned Runtime tasks, with or without a Run."""

from datetime import datetime, timezone
from typing import Any
from unittest.mock import MagicMock

import httpx
import pytest
from fastapi import HTTPException
from sqlalchemy import event
from sqlalchemy.orm import Session

from app.models.delivery import (
    CloudProject,
    LoopItem,
    LoopItemTaskBinding,
    loop_datetime_value_is_unset,
)
from app.models.kind import Kind
from app.models.loop_item_execution import LoopItemExecution
from app.models.user import User
from app.schemas.delivery import LoopItemTaskBind
from app.services.loop_items.external_provider import (
    PARENT_MARKER,
    external_loop_item_provider,
)
from app.services.loop_items.service import loop_item_service
from app.tasks.robot_queue_tasks import emit_runtime_cancels
from tests.api.test_deliveries_api import delivery_project
from tests.services.test_loop_item_archive_permissions import archive_member


@pytest.fixture
def runtime_posts(monkeypatch: pytest.MonkeyPatch) -> MagicMock:
    """Replace only the external HTTP boundary, retaining all service logic."""

    client = MagicMock()
    client.__enter__.return_value = client
    client.post.return_value = httpx.Response(200, json={"accepted": True})
    monkeypatch.setattr(
        "app.services.runtime_cancellation.httpx.Client", lambda **_: client
    )
    return client.post


def _device(db: Session, owner_id: int, *, name: str = "archive-device") -> Kind:
    device = Kind(
        kind="Device",
        namespace="default",
        name=name,
        user_id=owner_id,
        is_active=True,
        json={"spec": {"deviceType": "app", "deviceId": name}},
    )
    db.add(device)
    db.flush()
    return device


def _issue(db: Session, project: CloudProject, **values: Any) -> LoopItem:
    item = LoopItem(
        cloud_project_id=project.id,
        title="Archive a bound Runtime task",
        status="in_progress",
        created_by_user_id=project.created_by_user_id,
        **values,
    )
    db.add(item)
    db.flush()
    return item


def _binding(
    db: Session,
    item: LoopItem,
    *,
    owner_id: int,
    device_id: str,
    task_id: str,
    **values: Any,
) -> LoopItemTaskBinding:
    binding = LoopItemTaskBinding(
        cloud_project_id=item.cloud_project_id,
        loop_item_id=item.id,
        task_user_id=owner_id,
        linked_by_user_id=owner_id,
        linked_at=datetime.now(timezone.utc).replace(tzinfo=None),
        device_id=device_id,
        task_id=task_id,
        **values,
    )
    db.add(binding)
    db.flush()
    return binding


def test_archive_stops_manual_tasks_only_after_entire_subtree_commits(
    test_db: Session,
    test_user: User,
    delivery_project: CloudProject,
    runtime_posts: MagicMock,
) -> None:
    device = _device(test_db, test_user.id)
    root = _issue(test_db, delivery_project)
    child = _issue(test_db, delivery_project, parent_id=root.id)
    test_db.commit()
    for item in (root, child):
        loop_item_service.bind_task(
            test_db,
            item.id,
            LoopItemTaskBind(device_id=device.name, task_id=f"personal-{item.id}"),
            test_user.id,
        )
    assert test_db.query(LoopItemExecution).count() == 0
    committed = False
    snapshots: list[tuple[bool, list[tuple[bool, str]]]] = []

    def after_commit(_session: Session) -> None:
        nonlocal committed
        committed = True

    def post(_path: str, **request: Any) -> httpx.Response:
        with Session(bind=test_db.get_bind()) as fresh:
            persisted_states = []
            for item_id in (root.id, child.id):
                persisted = fresh.get(LoopItem, item_id)
                persisted_states.append(
                    (
                        not loop_datetime_value_is_unset(persisted.deleted_at),
                        persisted.status,
                    )
                )
            snapshots.append((committed, persisted_states))
        return httpx.Response(200, json={"accepted": True})

    runtime_posts.side_effect = post
    event.listen(test_db, "after_commit", after_commit)
    try:
        loop_item_service.delete(test_db, root.id, test_user.id)
    finally:
        event.remove(test_db, "after_commit", after_commit)

    payloads = [call.kwargs["json"] for call in runtime_posts.call_args_list]
    assert {entry["payload"]["taskId"] for entry in payloads} == {
        f"personal-{root.id}",
        f"personal-{child.id}",
    }
    assert len(payloads) == 2
    assert snapshots == [(True, [(True, "in_progress")] * 2)] * 2
    assert all(
        entry
        == {
            "user_id": test_user.id,
            "device_id": f"app-record-{device.id}",
            "method": "runtime.tasks.cancel",
            "payload": {
                "taskId": entry["payload"]["taskId"],
                "deviceId": device.name,
            },
            "wait_ack": True,
            "ack_timeout_seconds": 15,
        }
        for entry in payloads
    )
    assert test_db.query(LoopItemExecution).count() == 0


def test_archive_filters_other_owners_and_inactive_or_untrusted_bindings(
    test_db: Session,
    test_user: User,
    delivery_project: CloudProject,
    archive_member: User,
    runtime_posts: MagicMock,
) -> None:
    owned = _device(test_db, test_user.id)
    foreign = _device(test_db, archive_member.id, name="other-owner-device")
    inactive = _device(test_db, test_user.id, name="inactive-device")
    inactive.is_active = False
    item = _issue(test_db, delivery_project)
    outsider = _issue(test_db, delivery_project)
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    for task_id, owner_id, device_id, options in [
        ("allowed", test_user.id, owned.name, {}),
        ("other-owner", archive_member.id, foreign.name, {}),
        ("unlinked", test_user.id, owned.name, {"unlinked_at": now}),
        ("deleted", test_user.id, owned.name, {"deleted_at": now}),
        ("unknown-device", test_user.id, "unregistered", {}),
        ("foreign-device", test_user.id, foreign.name, {}),
        ("inactive-device", test_user.id, inactive.name, {}),
    ]:
        _binding(
            test_db,
            item,
            owner_id=owner_id,
            device_id=device_id,
            task_id=task_id,
            **options,
        )
    _binding(
        test_db,
        outsider,
        owner_id=test_user.id,
        device_id=owned.name,
        task_id="outside-subtree",
    )
    test_db.commit()

    loop_item_service.delete(test_db, item.id, test_user.id)

    assert runtime_posts.call_count == 1
    assert runtime_posts.call_args.kwargs["json"]["payload"]["taskId"] == "allowed"
    assert runtime_posts.call_args.kwargs["json"]["user_id"] == test_user.id
    assert loop_datetime_value_is_unset(outsider.deleted_at)


def test_archive_denied_descendant_sends_no_runtime_rpc(
    test_db: Session,
    test_user: User,
    delivery_project: CloudProject,
    archive_member: User,
    runtime_posts: MagicMock,
) -> None:
    device = _device(test_db, archive_member.id)
    root = _issue(test_db, delivery_project)
    root.created_by_user_id = archive_member.id
    child = _issue(
        test_db,
        delivery_project,
        parent_id=root.id,
        metadata_json={"security_level": "related"},
    )
    _binding(
        test_db,
        root,
        owner_id=archive_member.id,
        device_id=device.name,
        task_id="must-keep-running",
    )
    test_db.commit()
    versions = [root.version, child.version]

    with pytest.raises(HTTPException) as denied:
        loop_item_service.delete(test_db, root.id, archive_member.id)

    assert denied.value.status_code == 404
    runtime_posts.assert_not_called()
    test_db.expire_all()
    assert all(loop_datetime_value_is_unset(item.deleted_at) for item in (root, child))
    assert [root.version, child.version] == versions


def test_archive_commit_failure_sends_no_runtime_rpc_and_rolls_back(
    test_db: Session,
    test_user: User,
    delivery_project: CloudProject,
    runtime_posts: MagicMock,
) -> None:
    device = _device(test_db, test_user.id)
    item = _issue(test_db, delivery_project)
    _binding(
        test_db,
        item,
        owner_id=test_user.id,
        device_id=device.name,
        task_id="must-keep-running",
    )
    test_db.commit()
    version = item.version

    def fail_commit(_session: Session) -> None:
        assert not loop_datetime_value_is_unset(item.deleted_at)
        raise RuntimeError("Archive commit failed")

    event.listen(test_db, "before_commit", fail_commit)
    try:
        with pytest.raises(RuntimeError, match="Archive commit failed"):
            loop_item_service.delete(test_db, item.id, test_user.id)
    finally:
        event.remove(test_db, "before_commit", fail_commit)
    test_db.rollback()

    runtime_posts.assert_not_called()
    assert loop_datetime_value_is_unset(item.deleted_at)
    assert item.version == version


def test_archive_deduplicates_binding_aliases_with_queue_owned_execution(
    test_db: Session,
    test_user: User,
    delivery_project: CloudProject,
    runtime_posts: MagicMock,
) -> None:
    device = _device(test_db, test_user.id)
    item = _issue(test_db, delivery_project)
    canonical = f"app-record-{device.id}"
    for alias in (device.name, canonical):
        _binding(
            test_db,
            item,
            owner_id=test_user.id,
            device_id=alias,
            task_id="shared-runtime-task",
        )
    execution = LoopItemExecution(
        loop_item_id=item.id,
        cloud_project_id=delivery_project.id,
        executor_owner_user_id=test_user.id,
        execution_device_id=device.name,
        runtime_device_id=device.name,
        runtime_task_id="shared-runtime-task",
        status="running",
    )
    test_db.add(execution)
    test_db.commit()

    loop_item_service.delete(test_db, item.id, test_user.id)

    runtime_posts.assert_called_once()
    assert runtime_posts.call_args.kwargs["json"] == {
        "user_id": test_user.id,
        "device_id": device.name,
        "method": "runtime.tasks.cancel",
        "payload": {"taskId": "shared-runtime-task", "deviceId": device.name},
        "wait_ack": True,
        "ack_timeout_seconds": 15,
    }
    assert execution.status == "cancel_requested"
    assert not loop_datetime_value_is_unset(item.deleted_at)


def test_archive_transport_failure_keeps_committed_archive(
    test_db: Session,
    test_user: User,
    delivery_project: CloudProject,
    runtime_posts: MagicMock,
) -> None:
    device = _device(test_db, test_user.id)
    item = _issue(test_db, delivery_project)
    _binding(
        test_db,
        item,
        owner_id=test_user.id,
        device_id=device.name,
        task_id="offline-runtime-task",
    )
    test_db.commit()
    runtime_posts.side_effect = httpx.ConnectError("Runtime offline")

    result = loop_item_service.delete(test_db, item.id, test_user.id)

    runtime_posts.assert_called_once()
    assert result.id == item.id
    test_db.expire_all()
    assert not loop_datetime_value_is_unset(item.deleted_at)
    assert item.status == "in_progress"


@pytest.mark.parametrize("accepted", [True, False])
def test_runtime_cancel_ack_maps_to_all_execution_ids_at_one_address(
    test_db: Session,
    test_user: User,
    delivery_project: CloudProject,
    runtime_posts: MagicMock,
    accepted: bool,
) -> None:
    item = _issue(test_db, delivery_project)
    executions = [
        LoopItemExecution(
            loop_item_id=item.id,
            cloud_project_id=delivery_project.id,
            executor_owner_user_id=test_user.id,
            execution_device_id="transport-route",
            runtime_device_id="runtime-payload-identity",
            runtime_task_id="shared-runtime-task",
            status="cancel_requested",
        )
        for _ in range(2)
    ]
    test_db.add_all(executions)
    test_db.commit()
    runtime_posts.return_value = httpx.Response(200, json={"accepted": accepted})

    result = emit_runtime_cancels(executions)

    assert result == ({execution.id for execution in executions} if accepted else set())
    runtime_posts.assert_called_once()
    payload = runtime_posts.call_args.kwargs["json"]
    assert payload["device_id"] == "transport-route"
    assert payload["payload"]["deviceId"] == "runtime-payload-identity"
    assert all(execution.status == "cancel_requested" for execution in executions)


def _external_issues(
    db: Session,
    project: CloudProject,
    owner_id: int,
    provider: str,
    monkeypatch: pytest.MonkeyPatch,
) -> tuple[dict[int, dict[str, Any]], list[tuple[int, str]]]:
    """Keep provider I/O external while exercising real shadows and bindings."""

    project.metadata_json = {
        "task_provider": provider,
        "provider_config": {"repository": "fixture/project"},
    }
    db.commit()
    issues: dict[int, dict[str, Any]] = {}
    for number in (1, 2):
        labels = [
            f"wegent:creator:{owner_id}:Owner",
            "wegent:security:open",
            "wegent:status:in_progress",
        ]
        issues[number] = {
            "iid": number,
            "number": number,
            "title": f"External archive {number}",
            "state": "open" if provider == "github" else "opened",
            "body" if provider == "github" else "description": (
                f"{PARENT_MARKER} {project.project_key}-1" if number == 2 else "Root"
            ),
            "labels": (
                [{"name": label} for label in labels]
                if provider == "github"
                else labels
            ),
        }
    writes: list[tuple[int, str]] = []

    def update(
        _project: CloudProject, number: int, payload: dict[str, Any]
    ) -> dict[str, Any]:
        writes.append((number, str(payload["state"])))
        issues[number].update(payload)
        return issues[number]

    monkeypatch.setattr(
        external_loop_item_provider,
        "_list_issues",
        lambda _project: list(issues.values()),
    )
    monkeypatch.setattr(
        external_loop_item_provider,
        "_get_issue",
        lambda _project, number: issues[number],
    )
    monkeypatch.setattr(external_loop_item_provider, "_update_issue", update)
    return issues, writes


def _bind_external_task(
    db: Session,
    project: CloudProject,
    number: int,
    user_id: int,
    device: Kind,
) -> LoopItemTaskBinding:
    item_id = f"{project.project_key}-{number}"
    external_loop_item_provider.ensure_shadow(db, item_id, user_id)
    return loop_item_service.bind_task(
        db,
        item_id,
        LoopItemTaskBind(device_id=device.name, task_id=f"personal-{user_id}-{number}"),
        user_id,
    )


@pytest.mark.parametrize("provider", ["github", "gitlab"])
def test_external_archive_commits_before_stopping_only_actor_manual_tasks(
    test_db: Session,
    test_user: User,
    delivery_project: CloudProject,
    archive_member: User,
    runtime_posts: MagicMock,
    monkeypatch: pytest.MonkeyPatch,
    provider: str,
) -> None:
    issues, writes = _external_issues(
        test_db, delivery_project, test_user.id, provider, monkeypatch
    )
    device = _device(test_db, test_user.id)
    foreign = _device(test_db, archive_member.id, name="external-other-owner")
    bindings = [
        _bind_external_task(test_db, delivery_project, number, test_user.id, device)
        for number in (1, 2)
    ]
    other = _bind_external_task(
        test_db, delivery_project, 2, archive_member.id, foreign
    )
    assert test_db.query(LoopItemExecution).count() == 0
    committed = False
    snapshots: list[tuple[bool, list[str]]] = []

    def after_commit(_session: Session) -> None:
        nonlocal committed
        committed = True

    def post(_path: str, **_request: Any) -> httpx.Response:
        snapshots.append((committed, [issue["state"] for issue in issues.values()]))
        return httpx.Response(200, json={"accepted": True})

    runtime_posts.side_effect = post
    event.listen(test_db, "after_commit", after_commit)
    try:
        external_loop_item_provider.archive(
            test_db, f"{delivery_project.project_key}-1", test_user.id
        )
    finally:
        event.remove(test_db, "after_commit", after_commit)

    assert writes == [(2, "closed"), (1, "closed")]
    assert snapshots == [(True, ["closed", "closed"])] * 2
    payloads = [call.kwargs["json"] for call in runtime_posts.call_args_list]
    assert {payload["payload"]["taskId"] for payload in payloads} == {
        binding.task_id for binding in bindings
    }
    assert all(payload["user_id"] == test_user.id for payload in payloads)
    assert all(
        payload["device_id"] == f"app-record-{device.id}" for payload in payloads
    )
    assert loop_datetime_value_is_unset(other.unlinked_at)
    assert loop_datetime_value_is_unset(other.deleted_at)
    assert test_db.query(LoopItemExecution).count() == 0


@pytest.mark.parametrize("provider", ["github", "gitlab"])
@pytest.mark.parametrize("failure_stage", ["provider", "commit"])
def test_external_archive_failure_compensates_without_runtime_cancellation(
    test_db: Session,
    test_user: User,
    delivery_project: CloudProject,
    runtime_posts: MagicMock,
    monkeypatch: pytest.MonkeyPatch,
    provider: str,
    failure_stage: str,
) -> None:
    issues, writes = _external_issues(
        test_db, delivery_project, test_user.id, provider, monkeypatch
    )
    device = _device(test_db, test_user.id)
    binding = _bind_external_task(test_db, delivery_project, 2, test_user.id, device)
    update = external_loop_item_provider._update_issue

    def fail_provider(
        project: CloudProject, number: int, payload: dict[str, Any]
    ) -> dict[str, Any]:
        if number == 1 and payload["state"] == "closed":
            raise RuntimeError("Provider close failed")
        return update(project, number, payload)

    def fail_commit(_session: Session) -> None:
        raise RuntimeError("Archive commit failed")

    if failure_stage == "provider":
        monkeypatch.setattr(external_loop_item_provider, "_update_issue", fail_provider)
    else:
        event.listen(test_db, "before_commit", fail_commit)
    try:
        with pytest.raises(RuntimeError, match="close failed|commit failed"):
            external_loop_item_provider.archive(
                test_db, f"{delivery_project.project_key}-1", test_user.id
            )
    finally:
        if failure_stage == "commit":
            event.remove(test_db, "before_commit", fail_commit)

    runtime_posts.assert_not_called()
    open_state = "open" if provider == "github" else "opened"
    assert all(issue["state"] == open_state for issue in issues.values())
    assert writes == (
        [(2, "closed"), (2, open_state)]
        if failure_stage == "provider"
        else [(2, "closed"), (1, "closed"), (1, open_state), (2, open_state)]
    )
    assert loop_datetime_value_is_unset(binding.unlinked_at)
    assert loop_datetime_value_is_unset(binding.deleted_at)


@pytest.mark.parametrize("provider", ["github", "gitlab"])
def test_external_archive_denied_descendant_never_closes_or_cancels_tasks(
    test_db: Session,
    test_user: User,
    delivery_project: CloudProject,
    archive_member: User,
    runtime_posts: MagicMock,
    monkeypatch: pytest.MonkeyPatch,
    provider: str,
) -> None:
    issues, writes = _external_issues(
        test_db, delivery_project, test_user.id, provider, monkeypatch
    )
    device = _device(test_db, archive_member.id)
    binding = _bind_external_task(
        test_db, delivery_project, 1, archive_member.id, device
    )
    labels = issues[2]["labels"]
    if provider == "github":
        issues[2]["labels"] = [
            (
                {"name": "wegent:security:related"}
                if label["name"] == "wegent:security:open"
                else label
            )
            for label in labels
        ]
    else:
        issues[2]["labels"] = [
            "wegent:security:related" if label == "wegent:security:open" else label
            for label in labels
        ]

    with pytest.raises(HTTPException) as denied:
        external_loop_item_provider.archive(
            test_db, f"{delivery_project.project_key}-1", archive_member.id
        )

    assert denied.value.status_code == 404
    assert writes == []
    runtime_posts.assert_not_called()
    assert all(issue["state"] != "closed" for issue in issues.values())
    assert loop_datetime_value_is_unset(binding.unlinked_at)
