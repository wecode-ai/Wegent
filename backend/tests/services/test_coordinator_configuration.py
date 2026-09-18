from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException

from app.schemas.issue_workflow import WorkflowExecutionConfig
from app.services import (
    issue_execution_configuration,
    project_automations,
    runtime_profiles,
)


@pytest.mark.parametrize("configured", [False, True])
@pytest.mark.asyncio
async def test_manual_workflow_checks_configuration_before_creating_run(
    monkeypatch, configured
):
    service = project_automations.project_automation_service
    execution = project_automations.project_automation_execution
    rule = SimpleNamespace(
        created_by_user_id=7,
        metadata_json={
            "event_config": {
                "runtime_workflow_definition": {
                    "version": 1,
                    "stage_mode": "none",
                    "advancement_policy": "ai",
                    "ai_automation_rule_id": "rule",
                    "nodes": [],
                }
            }
        },
    )
    config = WorkflowExecutionConfig(
        execution_device_id="device-1" if configured else None,
        model="model-1" if configured else None,
        workspace_binding={"type": "standalone"},
    )
    monkeypatch.setattr(project_automations, "require_cloud_project_role", MagicMock())
    monkeypatch.setattr(service, "_rule", MagicMock(return_value=rule))
    monkeypatch.setattr(
        issue_execution_configuration,
        "project_automation_execution_config",
        MagicMock(return_value=config),
    )
    create_run = MagicMock(return_value=SimpleNamespace(id="run-1"))
    dispatch = AsyncMock()
    monkeypatch.setattr(service, "_create_run", create_run)
    monkeypatch.setattr(service, "_run_view", MagicMock(return_value={"id": "run-1"}))
    monkeypatch.setattr(execution, "dispatch", dispatch)

    if configured:
        assert await service.run_now(MagicMock(), "project", "rule", 7) == {
            "id": "run-1"
        }
        create_run.assert_called_once()
        dispatch.assert_awaited_once()
    else:
        with pytest.raises(HTTPException) as error:
            await service.run_now(MagicMock(), "project", "rule", 7)
        assert error.value.status_code == 422
        assert error.value.detail["missing_fields"] == ["device", "model"]
        assert (
            error.value.detail["error_code"]
            == "COORDINATOR_EXECUTION_CONFIG_INCOMPLETE"
        )
        create_run.assert_not_called()
        dispatch.assert_not_awaited()


def test_managed_coordinator_accepts_no_custom_configuration():
    issue_execution_configuration.require_coordinator_execution_config(None)


def test_workflow_execution_config_merges_runtime_capabilities():
    base = WorkflowExecutionConfig(
        runtime="codex",
        system_prompt="Base instructions",
        additional_skills=[{"name": "base"}],
        mcp_servers={"base": {"command": "base"}},
    )
    override = WorkflowExecutionConfig(
        runtime="claude_code",
        system_prompt="Review instructions",
        additional_skills=[],
        mcp_servers={"review": {"command": "review"}},
    )

    merged = base.merged_with(override)

    assert merged.runtime == "claude_code"
    assert merged.system_prompt == "Review instructions"
    assert merged.additional_skills == []
    assert merged.mcp_servers == {"review": {"command": "review"}}
    assert merged.runtime_request_options()["runtime"] == "claude_code"
    assert merged.runtime_request_options()["system_prompt"] == "Review instructions"
    assert merged.runtime_request_options()["mcp_servers"] == {
        "review": {"command": "review"}
    }


def test_project_default_rejects_profile_without_model(monkeypatch):
    service = runtime_profiles.runtime_profile_service
    monkeypatch.setattr(runtime_profiles, "require_cloud_project_role", MagicMock())
    monkeypatch.setattr(
        service,
        "require_owned",
        MagicMock(
            return_value=SimpleNamespace(
                status="active", device_id="device-1", metadata_json={}
            )
        ),
    )
    db = MagicMock()

    with pytest.raises(HTTPException, match="Runtime profile has no model"):
        service.set_project_default(db, "project", 7, "profile")

    db.add.assert_not_called()
    db.commit.assert_not_called()
