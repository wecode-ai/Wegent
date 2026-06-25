# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest
from fastapi import HTTPException

from app.api.endpoints.admin.public_bots import (
    _bot_to_response,
    _validate_bot_resource_references,
    _validate_public_default_knowledge_base_refs,
)
from app.models.kind import Kind
from app.models.namespace import Namespace
from app.schemas.admin import PublicBotCreate, PublicBotUpdate
from app.services.public_resource_validation import (
    validate_public_ghost_default_knowledge_bases,
)


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


def test_public_bot_default_kb_allows_organization_knowledge_base(test_db):
    namespace = Namespace(
        name="company",
        display_name="Company",
        owner_user_id=1,
        visibility="public",
        level="organization",
        is_active=True,
    )
    kb = Kind(
        user_id=1,
        kind="KnowledgeBase",
        name="company-kb",
        namespace="company",
        json={"spec": {"name": "Company Docs"}},
        is_active=True,
    )
    test_db.add_all([namespace, kb])
    test_db.commit()
    test_db.refresh(kb)

    _validate_public_default_knowledge_base_refs(
        test_db, [{"id": kb.id, "name": "Company Docs"}]
    )


def test_public_bot_default_kb_rejects_personal_knowledge_base(test_db):
    kb = Kind(
        user_id=7,
        kind="KnowledgeBase",
        name="private-kb",
        namespace="default",
        json={"spec": {"name": "Private Docs"}},
        is_active=True,
    )
    test_db.add(kb)
    test_db.commit()
    test_db.refresh(kb)

    with pytest.raises(HTTPException) as exc_info:
        _validate_public_default_knowledge_base_refs(
            test_db, [{"id": kb.id, "name": "Private Docs"}]
        )

    assert exc_info.value.status_code == 400
    assert "Public resources can only bind organization knowledge bases" in str(
        exc_info.value.detail
    )


def test_public_ghost_default_kb_rejects_personal_knowledge_base(test_db):
    kb = Kind(
        user_id=7,
        kind="KnowledgeBase",
        name="private-kb",
        namespace="default",
        json={"spec": {"name": "Private Docs"}},
        is_active=True,
    )
    test_db.add(kb)
    test_db.commit()
    test_db.refresh(kb)

    with pytest.raises(HTTPException) as exc_info:
        validate_public_ghost_default_knowledge_bases(
            test_db,
            {
                "spec": {
                    "defaultKnowledgeBaseRefs": [{"id": kb.id, "name": "Private Docs"}]
                }
            },
        )

    assert exc_info.value.status_code == 400
    assert "Public resources can only bind organization knowledge bases" in str(
        exc_info.value.detail
    )


def test_public_bot_raw_json_rejects_existing_ghost_with_personal_default_kb(test_db):
    kb = Kind(
        user_id=7,
        kind="KnowledgeBase",
        name="private-kb",
        namespace="default",
        json={"spec": {"name": "Private Docs"}},
        is_active=True,
    )
    test_db.add(kb)
    test_db.commit()
    test_db.refresh(kb)

    ghost = Kind(
        user_id=0,
        kind="Ghost",
        name="public-ghost",
        namespace="default",
        json={
            "spec": {
                "systemPrompt": "hello",
                "defaultKnowledgeBaseRefs": [{"id": kb.id, "name": "Private Docs"}],
            }
        },
        is_active=True,
    )
    test_db.add(ghost)
    test_db.commit()

    with pytest.raises(HTTPException) as exc_info:
        _validate_bot_resource_references(
            test_db,
            {"spec": {"ghostRef": {"name": "public-ghost", "namespace": "default"}}},
        )

    assert exc_info.value.status_code == 400
    assert "Public resources can only bind organization knowledge bases" in str(
        exc_info.value.detail
    )
