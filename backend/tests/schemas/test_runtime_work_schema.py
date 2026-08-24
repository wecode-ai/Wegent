# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest
from pydantic import ValidationError

from app.schemas.runtime_work import (
    RuntimeGuidanceRequest,
    RuntimeTaskAddress,
    RuntimeTaskCreateRequest,
)


def test_runtime_guidance_accepts_image_attachment_without_text() -> None:
    request = RuntimeGuidanceRequest(
        address=RuntimeTaskAddress(deviceId="device-1", taskId="runtime-1"),
        attachmentIds=[1],
    )

    assert request.message == ""
    assert request.attachment_ids == [1]


def test_runtime_guidance_requires_text_or_attachment() -> None:
    with pytest.raises(ValidationError, match="message or attachment is required"):
        RuntimeGuidanceRequest(
            address=RuntimeTaskAddress(deviceId="device-1", taskId="runtime-1"),
        )


def test_runtime_task_create_v2_accepts_input_composer_capabilities() -> None:
    request = RuntimeTaskCreateRequest(
        schemaVersion=2,
        projectId=7,
        deviceWorkspaceId=9,
        taskId="runtime-1",
        runtime="codex",
        runtimePermissionMode="plan",
        message="Implement the task",
        clientUserMessageId="message-1",
        modelSelection={
            "modelName": "gpt-5.6",
            "modelType": "cloud",
            "options": {"reasoningEffort": "high"},
        },
        initialGoal={
            "objective": "Finish the implementation",
            "status": "active",
            "tokenBudget": 100_000,
        },
        initialSupervisor={
            "mode": "auto",
            "instructions": "Check progress and correct deviations",
            "modelSelection": {
                "modelName": "gpt-5.6",
                "modelType": "cloud",
                "options": {},
            },
            "intervalSeconds": 60,
        },
        additionalSkills=[{"name": "project-space"}],
        attachments=[{"id": 11, "name": "requirements.md"}],
        origin={
            "type": "board_task",
            "cloudProjectId": "5",
            "loopItemId": "item-1",
        },
    )

    assert request.schema_version == 2
    assert request.local_task_id == "runtime-1"
    assert request.runtime_permission_mode == "plan"
    assert request.initial_goal is not None
    assert request.initial_goal.token_budget == 100_000
    assert request.initial_supervisor is not None
    assert request.initial_supervisor.interval_seconds == 60
    assert request.origin == {
        "type": "board_task",
        "cloudProjectId": "5",
        "loopItemId": "item-1",
    }


def test_runtime_task_create_preserves_cloud_project_id_as_string() -> None:
    request = RuntimeTaskCreateRequest(
        runtime="codex",
        message="Implement the task",
        cloudProjectId="3925292983218430463",
    )

    payload = request.model_dump(by_alias=True, exclude_none=True)

    assert payload["cloudProjectId"] == "3925292983218430463"


def test_runtime_task_create_rejects_invalid_supervisor_interval() -> None:
    with pytest.raises(ValidationError):
        RuntimeTaskCreateRequest(
            schemaVersion=2,
            projectId=7,
            deviceWorkspaceId=9,
            runtime="codex",
            message="Implement the task",
            initialSupervisor={
                "mode": "auto",
                "modelSelection": {
                    "modelName": "gpt-5.6",
                    "modelType": "cloud",
                    "options": {},
                },
                "intervalSeconds": 15,
            },
        )
