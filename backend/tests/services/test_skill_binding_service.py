# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from app.models.kind import Kind
from app.models.user import User
from app.schemas.skill_binding import (
    SkillBindingException,
    SkillBindingExceptionType,
)
from app.services.skill_binding_service import (
    SkillBindingContext,
    skill_binding_service,
)


def _create_skill(test_db, *, user_id: int, name: str = "auto-skill") -> Kind:
    skill = Kind(
        user_id=user_id,
        kind="Skill",
        name=name,
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Skill",
            "metadata": {"name": name, "namespace": "default"},
            "spec": {"description": "Automatic skill"},
        },
        is_active=True,
    )
    test_db.add(skill)
    test_db.commit()
    test_db.refresh(skill)
    return skill


def test_user_default_binding_response_includes_exceptions(test_db, test_user: User):
    skill = _create_skill(test_db, user_id=test_user.id)
    binding = skill_binding_service.add_user_default_skill(
        test_db,
        user_id=test_user.id,
        skill_id=skill.id,
        created_by=test_user.id,
    )

    updated = skill_binding_service.update_user_default_skill_exceptions(
        test_db,
        user_id=test_user.id,
        skill_id=skill.id,
        exceptions=[
            SkillBindingException(type=SkillBindingExceptionType.MODE, value="code"),
            SkillBindingException(type=SkillBindingExceptionType.MODE, value="code"),
            SkillBindingException(type=SkillBindingExceptionType.AGENT, value="100"),
        ],
    )

    response = skill_binding_service.to_response(updated)
    assert response.id == binding.id
    assert [item.model_dump() for item in response.exceptions] == [
        {"type": "mode", "value": "code"},
        {"type": "agent", "value": "100"},
    ]


def test_user_default_binding_can_force_preload_runtime_ref(test_db, test_user: User):
    skill = _create_skill(test_db, user_id=test_user.id, name="force-skill")
    skill_binding_service.add_user_default_skill(
        test_db,
        user_id=test_user.id,
        skill_id=skill.id,
        created_by=test_user.id,
    )

    updated = skill_binding_service.update_user_default_skill_exceptions(
        test_db,
        user_id=test_user.id,
        skill_id=skill.id,
        exceptions=[],
        force_preload=True,
    )

    response = skill_binding_service.to_response(updated)
    refs = skill_binding_service.list_user_default_skill_refs(
        test_db,
        test_user.id,
        context=SkillBindingContext(mode="chat", agent_id=100),
    )

    assert response.force_preload is True
    assert refs == [
        {
            "skill_id": skill.id,
            "name": "force-skill",
            "namespace": "default",
            "is_public": False,
            "force_preload": True,
        }
    ]


def test_user_default_skill_refs_skip_matching_mode_exception(test_db, test_user: User):
    skill = _create_skill(test_db, user_id=test_user.id, name="code-excluded")
    skill_binding_service.add_user_default_skill(
        test_db,
        user_id=test_user.id,
        skill_id=skill.id,
        created_by=test_user.id,
    )
    skill_binding_service.update_user_default_skill_exceptions(
        test_db,
        user_id=test_user.id,
        skill_id=skill.id,
        exceptions=[
            SkillBindingException(type=SkillBindingExceptionType.MODE, value="code"),
        ],
    )

    chat_refs = skill_binding_service.list_user_default_skill_refs(
        test_db,
        test_user.id,
        context=SkillBindingContext(mode="chat", agent_id=100),
    )
    code_refs = skill_binding_service.list_user_default_skill_refs(
        test_db,
        test_user.id,
        context=SkillBindingContext(mode="code", agent_id=100),
    )

    assert [ref["name"] for ref in chat_refs] == ["code-excluded"]
    assert code_refs == []


def test_user_default_skill_refs_skip_matching_agent_exception(
    test_db, test_user: User
):
    skill = _create_skill(test_db, user_id=test_user.id, name="agent-excluded")
    skill_binding_service.add_user_default_skill(
        test_db,
        user_id=test_user.id,
        skill_id=skill.id,
        created_by=test_user.id,
    )
    skill_binding_service.update_user_default_skill_exceptions(
        test_db,
        user_id=test_user.id,
        skill_id=skill.id,
        exceptions=[
            SkillBindingException(type=SkillBindingExceptionType.AGENT, value="200"),
        ],
    )

    included_refs = skill_binding_service.list_user_default_skill_refs(
        test_db,
        test_user.id,
        context=SkillBindingContext(mode="chat", agent_id=100),
    )
    excluded_refs = skill_binding_service.list_user_default_skill_refs(
        test_db,
        test_user.id,
        context=SkillBindingContext(mode="chat", agent_id=200),
    )

    assert [ref["name"] for ref in included_refs] == ["agent-excluded"]
    assert excluded_refs == []
