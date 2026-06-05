# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from app.api.endpoints.admin.public_bots import _bot_to_response
from app.models.kind import Kind
from app.schemas.admin import PublicBotCreate, PublicBotUpdate


def _preload_skill_refs() -> dict:
    return {
        "repo-reader": {
            "skill_id": 101,
            "namespace": "default",
            "is_public": True,
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
