# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.models.task import TaskResource
from app.services.device.command_service import DeviceCommandError
from app.services.turn_file_changes import turn_file_changes_service


def _summary(*, device_id="device-1", status="active"):
    return {
        "version": 1,
        "status": status,
        "artifact_id": "turn-file-changes/10/20",
        "device_id": device_id,
        "workspace_path": "/workspace/project",
        "file_count": 1,
        "additions": 3,
        "deletions": 1,
        "files": [
            {
                "old_path": None,
                "path": "src/app.ts",
                "change_type": "modified",
                "additions": 3,
                "deletions": 1,
                "binary": False,
            }
        ],
        "reverted_at": None,
    }


def _create_records(test_db, *, device_id="device-1", summary_device_id="device-1"):
    task = TaskResource(
        user_id=7,
        kind="Task",
        name="task-10",
        namespace="default",
        json={
            "kind": "Task",
            "spec": {"title": "Task", "device_id": device_id},
        },
        is_active=TaskResource.STATE_ACTIVE,
    )
    test_db.add(task)
    test_db.flush()
    subtask = Subtask(
        user_id=7,
        task_id=task.id,
        team_id=1,
        title="Assistant",
        bot_ids=[],
        role=SubtaskRole.ASSISTANT,
        status=SubtaskStatus.COMPLETED,
        result={
            "value": "done",
            "blocks": [{"id": "tool-1", "type": "tool"}],
            "file_changes": _summary(device_id=summary_device_id),
        },
    )
    test_db.add(subtask)
    test_db.commit()
    test_db.refresh(subtask)
    return task, subtask


def _command_result(payload):
    return {
        "success": True,
        "exit_code": 0,
        "stdout": payload,
        "stderr": "",
        "duration": 0.01,
    }


@pytest.mark.asyncio
async def test_get_diff_dispatches_recorded_device_and_workspace(
    test_db,
    monkeypatch,
):
    _, subtask = _create_records(test_db)
    execute = AsyncMock(
        return_value=_command_result({"success": True, "diff": "diff --git\n"})
    )
    monkeypatch.setattr(
        "app.services.turn_file_changes.execute_configured_device_command",
        execute,
    )

    response = await turn_file_changes_service.get_diff(
        db=test_db,
        user_id=7,
        subtask_id=subtask.id,
    )

    assert response.diff == "diff --git\n"
    execute.assert_awaited_once_with(
        db=test_db,
        user_id=7,
        device_id="device-1",
        command_key="turn_file_changes_review",
        path="/workspace/project",
        args=["turn-file-changes/10/20"],
        timeout_seconds=30,
        max_output_bytes=5 * 1024 * 1024,
    )


@pytest.mark.asyncio
async def test_get_diff_rejects_device_mismatch(test_db, monkeypatch):
    _, subtask = _create_records(
        test_db,
        device_id="device-2",
        summary_device_id="device-1",
    )
    execute = AsyncMock()
    monkeypatch.setattr(
        "app.services.turn_file_changes.execute_configured_device_command",
        execute,
    )

    with pytest.raises(HTTPException) as exc_info:
        await turn_file_changes_service.get_diff(
            db=test_db,
            user_id=7,
            subtask_id=subtask.id,
        )

    assert exc_info.value.status_code == 409
    assert exc_info.value.detail["code"] == "TURN_FILE_CHANGES_DEVICE_MISMATCH"
    execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_get_diff_reports_offline_device(test_db, monkeypatch):
    _, subtask = _create_records(test_db)
    monkeypatch.setattr(
        "app.services.turn_file_changes.execute_configured_device_command",
        AsyncMock(side_effect=DeviceCommandError("Device 'device-1' is offline")),
    )

    with pytest.raises(HTTPException) as exc_info:
        await turn_file_changes_service.get_diff(
            db=test_db,
            user_id=7,
            subtask_id=subtask.id,
        )

    assert exc_info.value.status_code == 409
    assert exc_info.value.detail["code"] == "TURN_FILE_CHANGES_DEVICE_OFFLINE"


@pytest.mark.asyncio
async def test_revert_updates_only_file_changes_status(test_db, monkeypatch):
    _, subtask = _create_records(test_db)
    monkeypatch.setattr(
        "app.services.turn_file_changes.execute_configured_device_command",
        AsyncMock(
            return_value=_command_result({"success": True, "status": "reverted"})
        ),
    )

    response = await turn_file_changes_service.revert(
        db=test_db,
        user_id=7,
        subtask_id=subtask.id,
    )
    test_db.refresh(subtask)

    assert response.file_changes.status == "reverted"
    assert response.file_changes.reverted_at is not None
    assert subtask.result["value"] == "done"
    assert subtask.result["blocks"] == [{"id": "tool-1", "type": "tool"}]


@pytest.mark.asyncio
async def test_revert_conflict_keeps_existing_message_result(test_db, monkeypatch):
    _, subtask = _create_records(test_db)
    monkeypatch.setattr(
        "app.services.turn_file_changes.execute_configured_device_command",
        AsyncMock(
            return_value=_command_result(
                {
                    "success": False,
                    "status": "conflicted",
                    "error": "patch does not apply",
                }
            )
        ),
    )

    with pytest.raises(HTTPException) as exc_info:
        await turn_file_changes_service.revert(
            db=test_db,
            user_id=7,
            subtask_id=subtask.id,
        )
    test_db.refresh(subtask)

    assert exc_info.value.status_code == 409
    assert exc_info.value.detail["code"] == "TURN_FILE_CHANGES_CONFLICT"
    assert subtask.result["value"] == "done"
    assert subtask.result["blocks"] == [{"id": "tool-1", "type": "tool"}]
    assert subtask.result["file_changes"]["status"] == "conflicted"


@pytest.mark.asyncio
async def test_revert_is_idempotent_after_success(test_db, monkeypatch):
    _, subtask = _create_records(test_db)
    result = dict(subtask.result)
    result["file_changes"] = _summary(status="reverted")
    subtask.result = result
    test_db.commit()
    execute = AsyncMock()
    monkeypatch.setattr(
        "app.services.turn_file_changes.execute_configured_device_command",
        execute,
    )

    response = await turn_file_changes_service.revert(
        db=test_db,
        user_id=7,
        subtask_id=subtask.id,
    )

    assert response.file_changes.status == "reverted"
    execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_missing_artifact_marks_artifact_missing(test_db, monkeypatch):
    _, subtask = _create_records(test_db)
    monkeypatch.setattr(
        "app.services.turn_file_changes.execute_configured_device_command",
        AsyncMock(
            return_value=_command_result(
                {
                    "success": False,
                    "status": "artifact_missing",
                    "error": "turn file changes artifact is missing",
                }
            )
        ),
    )

    with pytest.raises(HTTPException) as exc_info:
        await turn_file_changes_service.get_diff(
            db=test_db,
            user_id=7,
            subtask_id=subtask.id,
        )
    test_db.refresh(subtask)

    assert exc_info.value.status_code == 410
    assert subtask.result["file_changes"]["status"] == "artifact_missing"
