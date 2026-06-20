# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for local Codex thread binding service."""

import pytest

from app.core.constants import (
    CLIENT_ORIGIN_WEWORK,
    LABEL_LOCAL_CODEX_DEVICE_ID,
    LABEL_LOCAL_CODEX_THREAD_ID,
    WORKSPACE_SOURCE_LOCAL_CODEX_THREAD,
)
from app.models.kind import Kind
from app.models.task import TaskResource
from app.services.local_codex_thread_service import (
    bind_local_codex_thread,
    normalize_codex_thread_id,
)


def _add_device(test_db, *, user_id: int, device_id: str = "device-abc") -> Kind:
    device = Kind(
        user_id=user_id,
        kind="Device",
        name=device_id,
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Device",
            "metadata": {"name": device_id, "namespace": "default"},
            "spec": {"deviceId": device_id},
        },
    )
    test_db.add(device)
    test_db.commit()
    return device


def _add_team(test_db, *, user_id: int, name: str = "codex-team") -> Kind:
    team = Kind(
        user_id=user_id,
        kind="Team",
        name=name,
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Team",
            "metadata": {"name": name, "namespace": "default"},
            "spec": {"members": [], "collaborationModel": "solo"},
        },
    )
    test_db.add(team)
    test_db.commit()
    return team


def test_normalize_codex_thread_id_accepts_uuid_like_ids() -> None:
    assert (
        normalize_codex_thread_id("  018f2d6b-8c7a-7abc-9def-0123456789ab  ")
        == "018f2d6b-8c7a-7abc-9def-0123456789ab"
    )


@pytest.mark.parametrize(
    "thread_id",
    [
        "../session.jsonl",
        "session; rm -rf /",
        "$(cat ~/.ssh/id_rsa)",
        "/Users/test/.codex/session.jsonl",
        "018f2d6b-8c7a-7abc-9def-0123456789ab.jsonl",
        "",
    ],
)
def test_normalize_codex_thread_id_rejects_path_and_shell_values(
    thread_id: str,
) -> None:
    with pytest.raises(ValueError):
        normalize_codex_thread_id(thread_id)


def test_bind_local_codex_thread_creates_task_with_binding_metadata(
    test_db,
    test_user,
) -> None:
    _add_device(test_db, user_id=test_user.id, device_id="device-abc")
    team = _add_team(test_db, user_id=test_user.id)

    result = bind_local_codex_thread(
        db=test_db,
        user=test_user,
        team=team,
        device_id="device-abc",
        thread_id="018f2d6b-8c7a-7abc-9def-0123456789ab",
        title="Investigate API failure",
        cwd="/tmp/project",
    )

    assert result.created is True
    assert result.task_id == result.task.id
    assert result.task.name.startswith("local-codex-")
    assert result.task.client_origin == CLIENT_ORIGIN_WEWORK
    spec = result.task.json["spec"]
    labels = result.task.json["metadata"]["labels"]
    assert result.task.json["metadata"]["name"] == result.task.name
    assert spec["device_id"] == "device-abc"
    assert (
        spec["execution"]["workspace"]["source"] == WORKSPACE_SOURCE_LOCAL_CODEX_THREAD
    )
    assert spec["execution"]["workspace"]["path"] == "/tmp/project"
    assert spec["teamRef"]["name"] == team.name
    assert result.task.json["status"]["status"] == "COMPLETED"
    assert labels[LABEL_LOCAL_CODEX_THREAD_ID] == "018f2d6b-8c7a-7abc-9def-0123456789ab"
    assert labels[LABEL_LOCAL_CODEX_DEVICE_ID] == "device-abc"


def test_bind_local_codex_thread_reuses_existing_task_for_same_binding(
    test_db,
    test_user,
) -> None:
    _add_device(test_db, user_id=test_user.id, device_id="device-abc")
    team = _add_team(test_db, user_id=test_user.id)

    first = bind_local_codex_thread(
        db=test_db,
        user=test_user,
        team=team,
        device_id="device-abc",
        thread_id="018f2d6b-8c7a-7abc-9def-0123456789ab",
        title="First title",
    )
    second = bind_local_codex_thread(
        db=test_db,
        user=test_user,
        team=team,
        device_id="device-abc",
        thread_id="018f2d6b-8c7a-7abc-9def-0123456789ab",
        title="Updated title",
    )

    assert first.created is True
    assert second.created is False
    assert second.task_id == first.task_id
    assert second.task.id == first.task.id


def test_bind_local_codex_thread_restores_archived_binding(
    test_db,
    test_user,
) -> None:
    _add_device(test_db, user_id=test_user.id, device_id="device-abc")
    team = _add_team(test_db, user_id=test_user.id)

    first = bind_local_codex_thread(
        db=test_db,
        user=test_user,
        team=team,
        device_id="device-abc",
        thread_id="018f2d6b-8c7a-7abc-9def-0123456789ab",
        title="First title",
    )
    first.task.is_active = TaskResource.STATE_ARCHIVED
    test_db.commit()

    second = bind_local_codex_thread(
        db=test_db,
        user=test_user,
        team=team,
        device_id="device-abc",
        thread_id="018f2d6b-8c7a-7abc-9def-0123456789ab",
        title="Updated title",
    )

    assert second.created is False
    assert second.task_id == first.task_id
    assert second.task.is_active == TaskResource.STATE_ACTIVE


def test_bind_local_codex_thread_releases_deleted_binding_name(
    test_db,
    test_user,
) -> None:
    _add_device(test_db, user_id=test_user.id, device_id="device-abc")
    team = _add_team(test_db, user_id=test_user.id)

    first = bind_local_codex_thread(
        db=test_db,
        user=test_user,
        team=team,
        device_id="device-abc",
        thread_id="018f2d6b-8c7a-7abc-9def-0123456789ab",
        title="First title",
    )
    stable_name = first.task.name
    first.task.is_active = TaskResource.STATE_DELETED
    test_db.commit()

    second = bind_local_codex_thread(
        db=test_db,
        user=test_user,
        team=team,
        device_id="device-abc",
        thread_id="018f2d6b-8c7a-7abc-9def-0123456789ab",
        title="Updated title",
    )

    test_db.refresh(first.task)
    assert second.created is True
    assert second.task_id != first.task_id
    assert second.task.name == stable_name
    assert first.task.name == f"released-local-codex-{first.task_id}"

    second.task.is_active = TaskResource.STATE_DELETED
    test_db.commit()

    third = bind_local_codex_thread(
        db=test_db,
        user=test_user,
        team=team,
        device_id="device-abc",
        thread_id="018f2d6b-8c7a-7abc-9def-0123456789ab",
        title="Third title",
    )

    test_db.refresh(second.task)
    assert third.created is True
    assert third.task_id != second.task_id
    assert third.task.name == stable_name
    assert second.task.name == f"released-local-codex-{second.task_id}"


def test_bind_local_codex_thread_validates_device_ownership(test_db, test_user) -> None:
    other_device = _add_device(
        test_db, user_id=test_user.id + 100, device_id="device-abc"
    )
    team = _add_team(test_db, user_id=test_user.id)

    with pytest.raises(ValueError, match="Device not found"):
        bind_local_codex_thread(
            db=test_db,
            user=test_user,
            team=team,
            device_id=other_device.name,
            thread_id="018f2d6b-8c7a-7abc-9def-0123456789ab",
        )
