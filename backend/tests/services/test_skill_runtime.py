# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace

import pytest

from app.services.device.capability_payloads import CapabilityPayloadResolver
from app.services.execution.request_builder import TaskRequestBuilder
from app.services.skill_resolution import build_skill_ref_meta
from shared.models.execution import ExecutionRequest

pytestmark = pytest.mark.unit


def test_package_shell_binding_survives_task_and_device_distribution():
    skill = SimpleNamespace(
        id=1279,
        name="document",
        namespace="default",
        user_id=0,
        json={
            "kind": "Skill",
            "metadata": {"name": "document", "namespace": "default"},
            "spec": {"description": "Documents", "bindShells": ["Chat"]},
            "status": {"fileHash": "a" * 64},
        },
    )
    ref = build_skill_ref_meta(skill)
    assert ref["bind_shells"] == ["Chat"]
    assert ref["content_hash"] == "sha256:" + "a" * 64
    assert TaskRequestBuilder(None)._build_skill_data(skill)["bindShells"] == ["Chat"]
    payload = CapabilityPayloadResolver()._skill_payload(skill, installed_skill_id=9)
    assert payload["bind_shells"] == ["Chat"]
    assert payload["installed_skill_id"] == 9


@pytest.mark.parametrize(
    ("schema_version", "team_id", "compile_on_device"),
    [(3, 42, False), (2, None, True)],
    ids=["team", "device-intent"],
)
def test_runtime_payload_preserves_selected_sandbox(
    mocker, schema_version, team_id, compile_on_device
):
    from app.schemas.runtime_work import RuntimeTaskCreateRequest
    from app.services import runtime_work_service

    reference = {"skill_id": 1286, "bind_shells": ["Chat"]}
    execution_request = ExecutionRequest(
        team_id=team_id or 0,
        bot=[
            {
                "shell_type": "ClaudeCode",
                "skills": ["sandbox"],
                "preload_skills": ["sandbox"],
                "skill_refs": {"sandbox": reference},
            }
        ],
        skill_names=["sandbox"],
        preload_skills=["sandbox"],
        skill_refs={"sandbox": reference},
        preload_skill_refs={"sandbox": reference},
    )
    mocker.patch.object(
        runtime_work_service,
        "_build_runtime_execution_request",
        return_value=execution_request,
    )

    compiled = runtime_work_service._compile_runtime_task_create(
        db=None,
        user_id=2,
        request=RuntimeTaskCreateRequest(
            schemaVersion=schema_version,
            wegentTeamId=team_id,
            deviceId="fixture-device",
            runtime="claude_code",
            compileOnDevice=compile_on_device,
            message="Use the selected sandbox",
        ),
        target=runtime_work_service.RuntimeTaskTarget(
            device_id="fixture-device", workspace_path="/workspace"
        ),
    )

    assert compiled.team_id == team_id
    assert compiled.payload["runtime"] == "claude_code"
    payload = compiled.payload["executionRequest"]
    assert payload["skill_names"] == ["sandbox"]
    assert payload["preload_skills"] == ["sandbox"]
    assert payload["skill_refs"]["sandbox"] == reference
    assert payload["preload_skill_refs"]["sandbox"] == reference
    assert payload["bot"][0]["skills"] == ["sandbox"]
    assert payload["bot"][0]["skill_refs"]["sandbox"] == reference
