"""Cloud routing preserves resource identity and triggering-user authorization."""

from copy import deepcopy

import pytest
from fastapi import HTTPException

from app.schemas.runner_routing import ModelIdentity
from app.services.runner_cloud_models import (
    cloud_model_catalog,
    execution_model_values,
    require_cloud_model,
)


@pytest.fixture
def cloud_model(test_user, monkeypatch):
    item = {
        "name": "cloud-model",
        "type": "public",
        "namespace": "default",
        "resourceUserId": 0,
        "config": {"protocol": "openai-responses", "api_key": "private-secret"},
    }
    monkeypatch.setattr(
        "app.services.runner_cloud_models.model_aggregation_service.list_available_models",
        lambda db, user, **kwargs: [deepcopy(item)],
    )
    return ModelIdentity.model_validate(
        {
            "runtime": "codex",
            "provider": "openai",
            "model_id": "upstream-model",
            "source": "cloud",
            "cloud_model": {
                "name": "cloud-model",
                "type": "public",
                "namespace": "default",
                "resource_user_id": 0,
            },
        }
    )


def test_catalog_contains_protocol_and_identity_without_credentials(
    test_db, test_user, cloud_model
):
    options = cloud_model_catalog(test_db, test_user.id)

    assert options[0]["config"] == {"protocol": "openai-responses"}
    assert options[0]["resourceUserId"] == 0
    assert "private-secret" not in str(options)


def test_cloud_uses_triggering_user_and_does_not_require_native_model(
    test_db, test_user, cloud_model, mocker
):
    resolve = mocker.patch(
        "app.services.llm_proxy_service.resolve_llm_proxy_model_config",
        return_value={"protocol": "openai-responses"},
    )
    values = execution_model_values(test_db, test_user.id, None, cloud_model)

    assert values == (
        "cloud-model",
        "public",
        {
            "weworkCloudModelNamespace": "default",
            "weworkCloudModelResourceUserId": "0",
            "weworkCloudModelUpstreamApiFormat": "openai-responses",
        },
        f"cloud_gateway:user:{test_user.id}",
    )
    assert resolve.call_args.args[1].id == test_user.id


def test_same_name_cannot_substitute_another_resource_owner(
    test_db, test_user, cloud_model, mocker
):
    resolve = mocker.patch(
        "app.services.llm_proxy_service.resolve_llm_proxy_model_config"
    )
    wrong_owner = cloud_model.model_copy(
        update={
            "cloud_model": cloud_model.cloud_model.model_copy(
                update={"resource_user_id": test_user.id}
            )
        }
    )

    with pytest.raises(HTTPException) as error:
        require_cloud_model(test_db, test_user.id, wrong_owner)

    assert error.value.detail["error_code"] == "RUNNER_MODEL_UNAVAILABLE"
    resolve.assert_not_called()


@pytest.mark.parametrize(
    "protocol", ["openai-responses", "openai-chat-completions", "anthropic-messages"]
)
def test_claude_preserves_upstream_protocol_for_executor_bridge(
    test_db, test_user, cloud_model, mocker, protocol
):
    mocker.patch(
        "app.services.llm_proxy_service.resolve_llm_proxy_model_config",
        return_value={"protocol": protocol},
    )

    options = require_cloud_model(
        test_db,
        test_user.id,
        cloud_model.model_copy(update={"runtime": "claude_code"}),
    )
    assert options["weworkCloudModelUpstreamApiFormat"] == protocol


@pytest.mark.parametrize("source", ["native", "cloud"])
def test_routed_team_materializes_current_model_without_a_stored_model(
    test_db, test_user, mocker, source
):
    from app.models.kind import Kind
    from app.schemas.runtime_work import RuntimeTaskMaterializeRequest
    from app.services import runtime_work_service
    from tests.services.test_loop_item_executions import (
        _make_native_team_binding,
        _make_project,
    )

    project = _make_project(test_db, test_user)
    agent, team = _make_native_team_binding(
        test_db, project, test_user, shell_type="Codex"
    )
    bot_ref = team.json["spec"]["members"][0]["botRef"]
    bot = (
        test_db.query(Kind)
        .filter_by(
            kind="Bot",
            user_id=test_user.id,
            namespace=bot_ref["namespace"],
            name=bot_ref["name"],
        )
        .one()
    )
    definition = deepcopy(bot.json)
    definition["spec"].pop("modelRef")
    identity = {
        "runtime": "codex",
        "provider": "selected-provider",
        "model_id": "selected-model",
        "source": source,
    }
    if source == "cloud":
        identity["cloud_model"] = {
            "name": "catalog-resource",
            "type": "public",
            "namespace": "default",
            "resource_user_id": 0,
        }
    definition["spec"].update(
        execution_policy={"mode": "project_pool"},
        model_policy={"mode": "fixed", "model": identity},
    )
    bot.json = definition
    test_db.flush()
    expected = {"model_id": "selected-model", "model_provider": "selected-provider"}
    if source == "cloud":
        mocker.patch(
            "app.services.chat.trigger.request_preparation._build_cloud_gateway_model_config",
            return_value=expected.copy(),
        )
    from app.services.project_chat.service import compiled_bot_config

    config = compiled_bot_config(test_db, agent, execution_user_id=test_user.id)
    assert config["model"] == (
        "selected-model" if source == "native" else "catalog-resource"
    )
    assert config["model_type"] == ("runtime" if source == "native" else "public")
    if source == "cloud":
        assert config["model_options"] == {
            "weworkCloudModelNamespace": "default",
            "weworkCloudModelResourceUserId": "0",
        }
    request = RuntimeTaskMaterializeRequest(
        schemaVersion=3,
        wegentTeamId=team.id,
        deviceId="selected-runner",
        workspacePath="/workspace/standalone",
        runtime="codex",
        message="Run the assigned agent",
        modelId=config["model"],
        modelType="runtime" if source == "native" else "public",
        modelOptions=(
            {"runnerModelProvider": "selected-provider"}
            if source == "native"
            else {
                "weworkCloudModelNamespace": "default",
                "weworkCloudModelResourceUserId": "0",
            }
        ),
    )

    execution = runtime_work_service._build_runtime_execution_request(
        db=test_db,
        user_id=test_user.id,
        request=request,
        target=runtime_work_service.RuntimeTaskTarget(
            device_id="selected-runner", workspace_path="/workspace/standalone"
        ),
    )

    for key, value in expected.items():
        assert execution.model_config[key] == value
    if source == "cloud":
        assert execution.model_config["wework_model_kind"] == "cloud"
    assert execution.user["id"] == test_user.id
    assert execution.team_id == team.id
    assert "modelRef" not in bot.json["spec"]


@pytest.mark.parametrize("source", ["native", "cloud"])
def test_fixed_bot_policy_resolves_without_legacy_model_binding(
    test_db, test_user, cloud_model, mocker, source
):
    from types import SimpleNamespace

    from app.services.execution.request_builder import TaskRequestBuilder

    identity = (
        cloud_model.model_copy(update={"source": "native", "cloud_model": None})
        if source == "native"
        else cloud_model
    )
    bot = SimpleNamespace(
        json={
            "spec": {"model_policy": {"mode": "fixed", "model": identity.model_dump()}}
        }
    )
    expected = {"model_id": "cloud-model", "api_key": "current-user-gateway-token"}
    if source == "cloud":
        mocker.patch(
            "app.services.llm_proxy_service.resolve_llm_proxy_model_config",
            return_value={"protocol": "openai-responses"},
        )
        gateway = mocker.patch(
            "app.services.chat.trigger.request_preparation._build_cloud_gateway_model_config",
            return_value=expected.copy(),
        )
    result = TaskRequestBuilder(test_db)._get_model_config(
        bot=bot,
        user_id=test_user.id,
        user_name="user",
        override_model_name=None,
        force_override=False,
        task_id=1,
        team_id=1,
    )
    if source == "native":
        assert result == {
            "model_id": identity.model_id,
            "model_provider": identity.provider,
        }
    else:
        assert result["model_id"] == expected["model_id"]
        assert result["api_key"] == expected["api_key"]
        assert gateway.call_args.kwargs["creator"].id == test_user.id


def test_user_selected_bot_policy_requires_runtime_selection(test_db, test_user):
    from types import SimpleNamespace

    from app.services.execution.request_builder import TaskRequestBuilder

    bot = SimpleNamespace(json={"spec": {"model_policy": {"mode": "user_select"}}})
    builder = TaskRequestBuilder(test_db)
    with pytest.raises(HTTPException) as error:
        builder._get_model_config(
            bot=bot,
            user_id=test_user.id,
            user_name="user",
            override_model_name=None,
            force_override=False,
            task_id=1,
            team_id=1,
        )
    assert error.value.detail["error_code"] == "RUNNER_MODEL_REQUIRED"
    assert builder._get_model_config(
        bot=bot,
        user_id=test_user.id,
        user_name="user",
        runtime_model_config={"model_id": "chosen"},
        override_model_name=None,
        force_override=False,
        task_id=1,
        team_id=1,
    ) == {"model_id": "chosen"}
