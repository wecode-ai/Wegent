# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from app.api.endpoints.admin.public_bots import (
    _bot_to_response,
    _build_bot_json_from_form_data,
    _validate_bot_resource_references,
)
from app.models.kind import Kind
from app.schemas.admin import PublicBotCreate, PublicBotUpdate


def _preload_skill_refs() -> dict:
    return {
        "repo-reader": {
            "skill_id": 101,
            "namespace": "default",
            "is_public": True,
            "content_hash": None,
        }
    }


def _dump_refs(refs: dict) -> dict:
    return {name: ref.model_dump() for name, ref in refs.items()}


def test_public_bot_create_accepts_preload_skill_fields():
    payload = PublicBotCreate.model_validate(
        {
            "name": "code-agent-bot",
            "namespace": "default",
            "shell_name": "ClaudeCode",
            "system_prompt": "Use the repo reader.",
            "skills": ["repo-reader"],
            "preload_skills": ["repo-reader"],
            "preload_skill_refs": _preload_skill_refs(),
        }
    )

    assert payload.preload_skills == ["repo-reader"]
    assert _dump_refs(payload.preload_skill_refs) == _preload_skill_refs()


def test_public_bot_update_accepts_preload_skill_fields():
    payload = PublicBotUpdate.model_validate(
        {
            "skills": ["repo-reader"],
            "preload_skills": ["repo-reader"],
            "preload_skill_refs": _preload_skill_refs(),
        }
    )

    assert payload.preload_skills == ["repo-reader"]
    assert _dump_refs(payload.preload_skill_refs) == _preload_skill_refs()


def test_public_bot_form_data_accepts_planning_llm() -> None:
    payload = PublicBotCreate.model_validate(
        {
            "name": "test-video-bot",
            "shell_name": "Chat",
            "secondary_model_name": "planning-llm",
            "secondary_model_namespace": "default",
        }
    )

    assert payload.secondary_model_name == "planning-llm"
    assert payload.secondary_model_namespace == "default"


def test_public_bot_json_persists_planning_llm() -> None:
    bot_json = _build_bot_json_from_form_data(
        bot_name="test-video-bot",
        namespace="default",
        shell_name="Chat",
        shell_namespace="default",
        ghost_name="test-video-ghost",
        model_ref_name="video-model",
        model_ref_namespace="default",
        secondary_model_name="planning-llm",
        secondary_model_namespace="default",
    )

    assert bot_json["spec"]["modelRef"]["name"] == "video-model"
    assert bot_json["spec"]["secondaryModelRef"] == {
        "name": "planning-llm",
        "namespace": "default",
    }


def test_public_bot_response_includes_preload_skill_fields(test_db):
    ghost = Kind(
        user_id=0,
        kind="Ghost",
        name="code-agent-bot-ghost",
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Ghost",
            "metadata": {"name": "code-agent-bot-ghost", "namespace": "default"},
            "spec": {
                "systemPrompt": "Use the repo reader.",
                "mcpServers": {},
                "skills": ["repo-reader"],
                "skill_refs": _preload_skill_refs(),
                "preload_skills": ["repo-reader"],
                "preload_skill_refs": _preload_skill_refs(),
            },
        },
        is_active=True,
    )
    bot = Kind(
        user_id=0,
        kind="Bot",
        name="code-agent-bot",
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Bot",
            "metadata": {"name": "code-agent-bot", "namespace": "default"},
            "spec": {
                "ghostRef": {
                    "name": "code-agent-bot-ghost",
                    "namespace": "default",
                },
                "shellRef": {"name": "ClaudeCode", "namespace": "default"},
                "secondaryModelRef": {
                    "name": "planning-llm",
                    "namespace": "default",
                },
            },
        },
        is_active=True,
    )
    test_db.add_all([ghost, bot])
    test_db.commit()
    test_db.refresh(bot)

    response = _bot_to_response(bot, test_db)

    assert response.preload_skills == ["repo-reader"]
    assert _dump_refs(response.preload_skill_refs) == _preload_skill_refs()
    assert response.secondary_model_name == "planning-llm"
    assert response.secondary_model_namespace == "default"


def test_public_bot_rejects_video_model_as_planning_model(test_db) -> None:
    model = Kind(
        user_id=0,
        kind="Model",
        name="invalid-planning-video-model",
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Model",
            "metadata": {
                "name": "invalid-planning-video-model",
                "namespace": "default",
            },
            "spec": {
                "modelType": "video",
                "modelConfig": {"model": "video-model"},
            },
        },
        is_active=True,
    )
    test_db.add(model)
    test_db.commit()

    is_valid, error = _validate_bot_resource_references(
        test_db,
        {
            "spec": {
                "secondaryModelRef": {
                    "name": model.name,
                    "namespace": model.namespace,
                }
            }
        },
    )

    assert is_valid is False
    assert error == (
        "Invalid bot JSON: 'spec.secondaryModelRef' must reference an LLM model"
    )


def test_public_video_bot_requires_planning_llm(test_db) -> None:
    model = Kind(
        user_id=0,
        kind="Model",
        name="video-model",
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Model",
            "metadata": {"name": "video-model", "namespace": "default"},
            "spec": {
                "modelType": "video",
                "modelConfig": {"model": "video-model"},
            },
        },
        is_active=True,
    )
    test_db.add(model)
    test_db.commit()

    is_valid, error = _validate_bot_resource_references(
        test_db,
        {
            "spec": {
                "modelRef": {
                    "name": model.name,
                    "namespace": model.namespace,
                }
            }
        },
    )

    assert is_valid is False
    assert error == (
        "Invalid bot JSON: video Bots require 'spec.secondaryModelRef' "
        "to reference an LLM model"
    )
