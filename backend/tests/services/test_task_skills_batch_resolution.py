# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import json
from types import SimpleNamespace
from unittest.mock import Mock, patch

import pytest
from sqlalchemy.orm import Session

from app.models.task import TaskResource
from app.schemas.kind import SkillRefMeta
from app.services.adapters.task_kinds.task_skills_resolver import resolve_task_skills
from app.stores.tasks import SqlAlchemyTaskStore


def _build_kind(user_id: int, payload: dict):
    return SimpleNamespace(user_id=user_id, json=payload, id=100, namespace="default")


@pytest.fixture(autouse=True)
def use_sqlalchemy_task_store(mocker):
    # These unit tests mock SQLAlchemy queries, independent of app startup plugins.
    mocker.patch(
        "app.services.adapters.task_kinds.task_skills_resolver.task_store",
        SqlAlchemyTaskStore(),
    )


@pytest.fixture(autouse=True)
def mock_user_default_skill_refs(mocker):
    return mocker.patch(
        "app.services.adapters.task_kinds.task_skills_resolver.skill_binding_service.list_user_default_skill_refs",
        return_value=[],
    )


@pytest.mark.unit
def test_resolve_task_skills_uses_batched_kind_loading_for_bots_and_ghosts():
    db = Mock(spec=Session)

    mock_task = Mock(spec=TaskResource)
    mock_task.id = 123
    mock_task.user_id = 7
    mock_task.kind = "Task"
    mock_task.is_active = TaskResource.STATE_ACTIVE
    mock_task.json = {"kind": "Task"}

    mock_task_query = Mock()
    mock_task_query.filter.return_value = mock_task_query
    mock_task_query.first.return_value = mock_task
    db.query.return_value = mock_task_query

    task_crd = SimpleNamespace(
        spec=SimpleNamespace(
            teamRef=SimpleNamespace(name="team-a", namespace="default"),
        ),
        metadata=SimpleNamespace(labels={}),
    )
    team_crd = SimpleNamespace(
        spec=SimpleNamespace(
            members=[
                SimpleNamespace(
                    botRef=SimpleNamespace(name="bot-a", namespace="default")
                ),
                SimpleNamespace(
                    botRef=SimpleNamespace(name="bot-b", namespace="default")
                ),
            ]
        )
    )

    bot_a = _build_kind(7, {"kind": "Bot", "name": "bot-a"})
    bot_b = _build_kind(7, {"kind": "Bot", "name": "bot-b"})
    ghost_a = _build_kind(7, {"kind": "Ghost", "name": "ghost-a"})
    ghost_b = _build_kind(7, {"kind": "Ghost", "name": "ghost-b"})

    bot_crd_a = SimpleNamespace(
        spec=SimpleNamespace(
            ghostRef=SimpleNamespace(name="ghost-a", namespace="default")
        )
    )
    bot_crd_b = SimpleNamespace(
        spec=SimpleNamespace(
            ghostRef=SimpleNamespace(name="ghost-b", namespace="default")
        )
    )
    ghost_crd_a = SimpleNamespace(
        spec=SimpleNamespace(skills=["alpha"], preload_skills=["pre-a"])
    )
    ghost_crd_b = SimpleNamespace(
        spec=SimpleNamespace(skills=["beta"], preload_skills=["pre-b"])
    )

    with (
        patch(
            "app.services.task_member_service.task_member_service.is_member",
            return_value=True,
        ),
        patch(
            "app.services.readers.kinds.kindReader.get_by_name_and_namespace",
            return_value=_build_kind(7, {"kind": "Team"}),
        ) as mock_kind_lookup,
        patch(
            "app.services.adapters.task_kinds.task_skills_resolver.Task.model_validate",
            return_value=task_crd,
        ),
        patch(
            "app.services.adapters.task_kinds.task_skills_resolver.Team.model_validate",
            return_value=team_crd,
        ),
        patch(
            "app.services.adapters.task_kinds.task_skills_resolver.Bot.model_validate",
            side_effect=[bot_crd_a, bot_crd_b],
        ),
        patch(
            "app.services.adapters.task_kinds.task_skills_resolver.Ghost.model_validate",
            side_effect=[ghost_crd_a, ghost_crd_b],
        ),
        patch(
            "app.services.adapters.task_kinds.task_skills_resolver._batch_load_kinds_by_refs",
            create=True,
            side_effect=[
                {
                    ("default", "bot-a"): bot_a,
                    ("default", "bot-b"): bot_b,
                },
                {
                    ("default", "ghost-a"): ghost_a,
                    ("default", "ghost-b"): ghost_b,
                },
            ],
        ) as mock_batch_loader,
    ):
        result = resolve_task_skills(db, task_id=123, user_id=99)

    assert set(result["skills"]) == {"alpha", "beta"}
    assert set(result["preload_skills"]) == {"pre-a", "pre-b"}
    assert mock_kind_lookup.call_count == 1
    assert mock_batch_loader.call_count == 2


@pytest.mark.unit
def test_resolve_task_skills_includes_skill_for_persisted_knowledge_provider():
    db = Mock(spec=Session)
    task = SimpleNamespace(
        id=123,
        user_id=7,
        project_id=None,
        json={"kind": "Task"},
    )
    task_crd = SimpleNamespace(
        spec=SimpleNamespace(
            teamRef=SimpleNamespace(name="missing-team", namespace="default"),
            externalKnowledgeRefs=[SimpleNamespace(provider="ap")],
        ),
        metadata=SimpleNamespace(labels={}),
    )
    skill = SimpleNamespace(id=456)
    skill_ref = {
        "skill_id": 456,
        "namespace": "default",
        "is_public": True,
    }

    with (
        patch(
            "app.services.adapters.task_kinds.task_skills_resolver.task_store.get_active_task",
            return_value=task,
        ),
        patch(
            "app.services.task_member_service.task_member_service.is_member",
            return_value=True,
        ),
        patch(
            "app.services.readers.kinds.kindReader.get_by_name_and_namespace",
            return_value=None,
        ),
        patch(
            "app.services.adapters.task_kinds.task_skills_resolver.Task.model_validate",
            return_value=task_crd,
        ),
        patch(
            "app.services.adapters.task_kinds.task_skills_resolver.get_provider_skill_name",
            return_value="ap-knowledge",
        ),
        patch(
            "app.services.adapters.task_kinds.task_skills_resolver.find_skill_by_ref",
            return_value=skill,
        ) as find_skill,
        patch(
            "app.services.adapters.task_kinds.task_skills_resolver.build_skill_ref_meta",
            return_value=skill_ref,
        ),
    ):
        result = resolve_task_skills(db, task_id=123, user_id=99)

    assert result["skills"] == ["ap-knowledge"]
    assert result["preload_skills"] == ["ap-knowledge"]
    assert result["skill_refs"] == {"ap-knowledge": skill_ref}
    assert result["preload_skill_refs"] == {"ap-knowledge": skill_ref}
    find_skill.assert_called_once_with(
        db,
        skill_name="ap-knowledge",
        namespace="default",
        is_public=True,
        user_id=7,
        team_namespace="default",
    )


@pytest.mark.unit
def test_resolve_task_skills_returns_refs_for_ghost_task_and_subscription_sources():
    db = Mock(spec=Session)

    mock_task = Mock(spec=TaskResource)
    mock_task.id = 123
    mock_task.user_id = 7
    mock_task.kind = "Task"
    mock_task.is_active = TaskResource.STATE_ACTIVE
    mock_task.json = {"kind": "Task"}

    mock_task_query = Mock()
    mock_task_query.filter.return_value = mock_task_query
    mock_task_query.first.return_value = mock_task
    db.query.return_value = mock_task_query

    task_crd = SimpleNamespace(
        spec=SimpleNamespace(
            teamRef=SimpleNamespace(name="team-a", namespace="team-a"),
        ),
        metadata=SimpleNamespace(
            labels={
                "additionalSkills": json.dumps(["manual-skill"]),
                "requestedSkillRefs": json.dumps(
                    [
                        {
                            "name": "manual-skill",
                            "namespace": "team-a",
                            "is_public": False,
                        }
                    ]
                ),
            }
        ),
    )
    team_crd = SimpleNamespace(
        spec=SimpleNamespace(
            members=[
                SimpleNamespace(
                    botRef=SimpleNamespace(name="bot-a", namespace="default")
                )
            ]
        )
    )

    bot_a = _build_kind(7, {"kind": "Bot", "name": "bot-a"})
    ghost_a = _build_kind(7, {"kind": "Ghost", "name": "ghost-a"})
    bot_crd_a = SimpleNamespace(
        spec=SimpleNamespace(
            ghostRef=SimpleNamespace(name="ghost-a", namespace="default")
        )
    )
    ghost_crd_a = SimpleNamespace(
        spec=SimpleNamespace(
            skills=["ghost-skill"],
            preload_skills=["ghost-skill"],
            skill_refs={
                "ghost-skill": SkillRefMeta(
                    skill_id=11, namespace="team-a", is_public=False
                )
            },
            preload_skill_refs={
                "ghost-skill": SkillRefMeta(
                    skill_id=12, namespace="team-a", is_public=False
                )
            },
        )
    )
    subscription_skill = SimpleNamespace(
        name="subscription-skill", namespace="team-a", is_public=False
    )
    resolved_subscription_skill = SimpleNamespace(id=33, namespace="team-a", user_id=7)

    with (
        patch(
            "app.services.task_member_service.task_member_service.is_member",
            return_value=True,
        ),
        patch(
            "app.services.readers.kinds.kindReader.get_by_name_and_namespace",
            return_value=_build_kind(7, {"kind": "Team"}),
        ),
        patch(
            "app.services.adapters.task_kinds.task_skills_resolver.Task.model_validate",
            return_value=task_crd,
        ),
        patch(
            "app.services.adapters.task_kinds.task_skills_resolver.Team.model_validate",
            return_value=team_crd,
        ),
        patch(
            "app.services.adapters.task_kinds.task_skills_resolver.Bot.model_validate",
            return_value=bot_crd_a,
        ),
        patch(
            "app.services.adapters.task_kinds.task_skills_resolver.Ghost.model_validate",
            return_value=ghost_crd_a,
        ),
        patch(
            "app.services.adapters.task_kinds.task_skills_resolver._batch_load_kinds_by_refs",
            create=True,
            side_effect=[
                {("default", "bot-a"): bot_a},
                {("default", "ghost-a"): ghost_a},
            ],
        ),
        patch(
            "app.services.adapters.task_kinds.task_skills_resolver._get_subscription_skill_refs_for_task",
            return_value=[subscription_skill],
        ),
        patch(
            "app.services.adapters.task_kinds.task_skills_resolver.find_skill_by_ref",
            side_effect=[
                resolved_subscription_skill,
                SimpleNamespace(id=22, namespace="team-a", user_id=7),
            ],
        ),
    ):
        result = resolve_task_skills(db, task_id=123, user_id=99)

    assert set(result["skills"]) == {
        "ghost-skill",
        "manual-skill",
        "subscription-skill",
    }
    assert set(result["preload_skills"]) == {
        "ghost-skill",
        "manual-skill",
        "subscription-skill",
    }
    assert result["skill_refs"]["ghost-skill"]["skill_id"] == 11
    assert result["preload_skill_refs"]["ghost-skill"]["skill_id"] == 12
    assert result["skill_refs"]["manual-skill"]["skill_id"] == 22
    assert result["preload_skill_refs"]["manual-skill"]["skill_id"] == 22
    assert result["skill_refs"]["subscription-skill"]["skill_id"] == 33


@pytest.mark.unit
def test_resolve_task_skills_includes_user_default_refs_without_preloading(
    mock_user_default_skill_refs,
):
    db = Mock(spec=Session)

    mock_task = Mock(spec=TaskResource)
    mock_task.id = 123
    mock_task.user_id = 7
    mock_task.kind = "Task"
    mock_task.is_active = TaskResource.STATE_ACTIVE
    mock_task.json = {"kind": "Task"}

    mock_task_query = Mock()
    mock_task_query.filter.return_value = mock_task_query
    mock_task_query.first.return_value = mock_task
    db.query.return_value = mock_task_query

    task_crd = SimpleNamespace(
        spec=SimpleNamespace(
            teamRef=SimpleNamespace(name="team-a", namespace="default")
        ),
        metadata=SimpleNamespace(labels={}),
    )
    team_crd = SimpleNamespace(
        spec=SimpleNamespace(
            members=[
                SimpleNamespace(
                    botRef=SimpleNamespace(name="bot-a", namespace="default")
                )
            ]
        )
    )
    bot_a = _build_kind(7, {"kind": "Bot", "name": "bot-a"})
    ghost_a = _build_kind(7, {"kind": "Ghost", "name": "ghost-a"})
    bot_crd_a = SimpleNamespace(
        spec=SimpleNamespace(
            ghostRef=SimpleNamespace(name="ghost-a", namespace="default")
        )
    )
    ghost_crd_a = SimpleNamespace(
        spec=SimpleNamespace(skills=["ghost-skill"], preload_skills=[])
    )
    mock_user_default_skill_refs.return_value = [
        {
            "skill_id": 44,
            "name": "default-skill",
            "namespace": "default",
            "is_public": False,
        }
    ]

    with (
        patch(
            "app.services.task_member_service.task_member_service.is_member",
            return_value=True,
        ),
        patch(
            "app.services.readers.kinds.kindReader.get_by_name_and_namespace",
            return_value=_build_kind(7, {"kind": "Team"}),
        ),
        patch(
            "app.services.adapters.task_kinds.task_skills_resolver.Task.model_validate",
            return_value=task_crd,
        ),
        patch(
            "app.services.adapters.task_kinds.task_skills_resolver.Team.model_validate",
            return_value=team_crd,
        ),
        patch(
            "app.services.adapters.task_kinds.task_skills_resolver.Bot.model_validate",
            return_value=bot_crd_a,
        ),
        patch(
            "app.services.adapters.task_kinds.task_skills_resolver.Ghost.model_validate",
            return_value=ghost_crd_a,
        ),
        patch(
            "app.services.adapters.task_kinds.task_skills_resolver._batch_load_kinds_by_refs",
            create=True,
            side_effect=[
                {("default", "bot-a"): bot_a},
                {("default", "ghost-a"): ghost_a},
            ],
        ),
    ):
        result = resolve_task_skills(db, task_id=123, user_id=99)

    assert "default-skill" in result["skills"]
    assert "default-skill" not in result["preload_skills"]
    assert result["skill_refs"]["default-skill"]["skill_id"] == 44
    assert "default-skill" not in result["preload_skill_refs"]


@pytest.mark.unit
def test_resolve_task_skills_adds_force_preloaded_user_default_skills_to_preload(
    mock_user_default_skill_refs,
):
    db = Mock(spec=Session)

    mock_task = Mock(spec=TaskResource)
    mock_task.id = 123
    mock_task.user_id = 7
    mock_task.kind = "Task"
    mock_task.project_id = None
    mock_task.is_active = TaskResource.STATE_ACTIVE
    mock_task.json = {"kind": "Task"}

    mock_task_query = Mock()
    mock_task_query.filter.return_value = mock_task_query
    mock_task_query.first.return_value = mock_task
    db.query.return_value = mock_task_query

    task_crd = SimpleNamespace(
        spec=SimpleNamespace(
            teamRef=SimpleNamespace(name="team-a", namespace="default")
        ),
        metadata=SimpleNamespace(labels={"taskType": "chat"}),
    )
    team_crd = SimpleNamespace(
        spec=SimpleNamespace(
            members=[
                SimpleNamespace(
                    botRef=SimpleNamespace(name="bot-a", namespace="default")
                )
            ]
        )
    )
    bot_a = _build_kind(7, {"kind": "Bot", "name": "bot-a"})
    ghost_a = _build_kind(7, {"kind": "Ghost", "name": "ghost-a"})
    bot_crd_a = SimpleNamespace(
        spec=SimpleNamespace(
            ghostRef=SimpleNamespace(name="ghost-a", namespace="default")
        )
    )
    ghost_crd_a = SimpleNamespace(spec=SimpleNamespace(skills=[], preload_skills=[]))
    mock_user_default_skill_refs.return_value = [
        {
            "skill_id": 44,
            "name": "default-skill",
            "namespace": "default",
            "is_public": False,
            "force_preload": True,
        }
    ]

    with (
        patch(
            "app.services.task_member_service.task_member_service.is_member",
            return_value=True,
        ),
        patch(
            "app.services.readers.kinds.kindReader.get_by_name_and_namespace",
            return_value=_build_kind(7, {"kind": "Team"}),
        ),
        patch(
            "app.services.adapters.task_kinds.task_skills_resolver.Task.model_validate",
            return_value=task_crd,
        ),
        patch(
            "app.services.adapters.task_kinds.task_skills_resolver.Team.model_validate",
            return_value=team_crd,
        ),
        patch(
            "app.services.adapters.task_kinds.task_skills_resolver.Bot.model_validate",
            return_value=bot_crd_a,
        ),
        patch(
            "app.services.adapters.task_kinds.task_skills_resolver.Ghost.model_validate",
            return_value=ghost_crd_a,
        ),
        patch(
            "app.services.adapters.task_kinds.task_skills_resolver._batch_load_kinds_by_refs",
            create=True,
            side_effect=[
                {("default", "bot-a"): bot_a},
                {("default", "ghost-a"): ghost_a},
            ],
        ),
    ):
        result = resolve_task_skills(db, task_id=123, user_id=99)

    assert "default-skill" in result["skills"]
    assert "default-skill" in result["preload_skills"]
    assert result["skill_refs"]["default-skill"]["skill_id"] == 44
    assert result["preload_skill_refs"]["default-skill"]["skill_id"] == 44


@pytest.mark.unit
def test_resolve_task_skills_passes_context_to_user_default_skill_refs(
    mock_user_default_skill_refs,
):
    db = Mock(spec=Session)

    mock_task = Mock(spec=TaskResource)
    mock_task.id = 123
    mock_task.user_id = 7
    mock_task.kind = "Task"
    mock_task.project_id = 55
    mock_task.is_active = TaskResource.STATE_ACTIVE
    mock_task.json = {"kind": "Task"}

    mock_task_query = Mock()
    mock_task_query.filter.return_value = mock_task_query
    mock_task_query.first.return_value = mock_task
    db.query.return_value = mock_task_query

    task_crd = SimpleNamespace(
        spec=SimpleNamespace(
            teamRef=SimpleNamespace(name="team-a", namespace="default"),
        ),
        metadata=SimpleNamespace(labels={"taskType": "code"}),
    )
    team_crd = SimpleNamespace(
        spec=SimpleNamespace(
            members=[
                SimpleNamespace(
                    botRef=SimpleNamespace(name="bot-a", namespace="default")
                )
            ]
        )
    )
    bot_a = _build_kind(7, {"kind": "Bot", "name": "bot-a"})
    ghost_a = _build_kind(7, {"kind": "Ghost", "name": "ghost-a"})
    bot_crd_a = SimpleNamespace(
        spec=SimpleNamespace(
            ghostRef=SimpleNamespace(name="ghost-a", namespace="default")
        )
    )
    ghost_crd_a = SimpleNamespace(spec=SimpleNamespace(skills=[], preload_skills=[]))

    with (
        patch(
            "app.services.task_member_service.task_member_service.is_member",
            return_value=True,
        ),
        patch(
            "app.services.readers.kinds.kindReader.get_by_name_and_namespace",
            return_value=_build_kind(7, {"kind": "Team"}),
        ),
        patch(
            "app.services.adapters.task_kinds.task_skills_resolver.Task.model_validate",
            return_value=task_crd,
        ),
        patch(
            "app.services.adapters.task_kinds.task_skills_resolver.Team.model_validate",
            return_value=team_crd,
        ),
        patch(
            "app.services.adapters.task_kinds.task_skills_resolver.Bot.model_validate",
            return_value=bot_crd_a,
        ),
        patch(
            "app.services.adapters.task_kinds.task_skills_resolver.Ghost.model_validate",
            return_value=ghost_crd_a,
        ),
        patch(
            "app.services.adapters.task_kinds.task_skills_resolver._batch_load_kinds_by_refs",
            create=True,
            side_effect=[
                {("default", "bot-a"): bot_a},
                {("default", "ghost-a"): ghost_a},
            ],
        ),
    ):
        resolve_task_skills(db, task_id=123, user_id=99)

    context = mock_user_default_skill_refs.call_args.kwargs["context"]
    assert context.mode == "code"
    assert context.agent_id == 100
    assert context.project_id == 55


@pytest.mark.unit
def test_resolve_task_skills_prefers_requested_skill_refs_over_subscription_and_ghost():
    db = Mock(spec=Session)

    mock_task = Mock(spec=TaskResource)
    mock_task.id = 123
    mock_task.user_id = 7
    mock_task.kind = "Task"
    mock_task.is_active = TaskResource.STATE_ACTIVE
    mock_task.json = {"kind": "Task"}

    mock_task_query = Mock()
    mock_task_query.filter.return_value = mock_task_query
    mock_task_query.first.return_value = mock_task
    db.query.return_value = mock_task_query

    task_crd = SimpleNamespace(
        spec=SimpleNamespace(
            teamRef=SimpleNamespace(name="team-a", namespace="team-a"),
        ),
        metadata=SimpleNamespace(
            labels={
                "requestedSkillRefs": json.dumps(
                    [
                        {
                            "name": "shared-skill",
                            "namespace": "chat-namespace",
                            "is_public": False,
                        }
                    ]
                )
            }
        ),
    )
    team_crd = SimpleNamespace(
        spec=SimpleNamespace(
            members=[
                SimpleNamespace(
                    botRef=SimpleNamespace(name="bot-a", namespace="default")
                )
            ]
        )
    )

    bot_a = _build_kind(7, {"kind": "Bot", "name": "bot-a"})
    ghost_a = _build_kind(7, {"kind": "Ghost", "name": "ghost-a"})
    bot_crd_a = SimpleNamespace(
        spec=SimpleNamespace(
            ghostRef=SimpleNamespace(name="ghost-a", namespace="default")
        )
    )
    ghost_crd_a = SimpleNamespace(
        spec=SimpleNamespace(
            skills=["shared-skill"],
            preload_skills=["shared-skill"],
            skill_refs={
                "shared-skill": SkillRefMeta(
                    skill_id=11, namespace="ghost-namespace", is_public=False
                )
            },
            preload_skill_refs={
                "shared-skill": SkillRefMeta(
                    skill_id=12, namespace="ghost-namespace", is_public=False
                )
            },
        )
    )
    subscription_skill = SimpleNamespace(
        name="shared-skill", namespace="subscription-namespace", is_public=False
    )

    with (
        patch(
            "app.services.task_member_service.task_member_service.is_member",
            return_value=True,
        ),
        patch(
            "app.services.readers.kinds.kindReader.get_by_name_and_namespace",
            return_value=_build_kind(7, {"kind": "Team"}),
        ),
        patch(
            "app.services.adapters.task_kinds.task_skills_resolver.Task.model_validate",
            return_value=task_crd,
        ),
        patch(
            "app.services.adapters.task_kinds.task_skills_resolver.Team.model_validate",
            return_value=team_crd,
        ),
        patch(
            "app.services.adapters.task_kinds.task_skills_resolver.Bot.model_validate",
            return_value=bot_crd_a,
        ),
        patch(
            "app.services.adapters.task_kinds.task_skills_resolver.Ghost.model_validate",
            return_value=ghost_crd_a,
        ),
        patch(
            "app.services.adapters.task_kinds.task_skills_resolver._batch_load_kinds_by_refs",
            create=True,
            side_effect=[
                {("default", "bot-a"): bot_a},
                {("default", "ghost-a"): ghost_a},
            ],
        ),
        patch(
            "app.services.adapters.task_kinds.task_skills_resolver._get_subscription_skill_refs_for_task",
            return_value=[subscription_skill],
        ),
        patch(
            "app.services.adapters.task_kinds.task_skills_resolver.find_skill_by_ref",
            side_effect=[
                SimpleNamespace(id=21, namespace="subscription-namespace", user_id=7),
                SimpleNamespace(id=22, namespace="chat-namespace", user_id=7),
            ],
        ),
    ):
        result = resolve_task_skills(db, task_id=123, user_id=99)

    assert result["skill_refs"]["shared-skill"]["skill_id"] == 22
    assert result["skill_refs"]["shared-skill"]["namespace"] == "chat-namespace"
    assert result["preload_skill_refs"]["shared-skill"]["skill_id"] == 22


@pytest.mark.unit
def test_resolve_task_skills_team_missing_still_uses_requested_skill_refs():
    db = Mock(spec=Session)

    mock_task = Mock(spec=TaskResource)
    mock_task.id = 123
    mock_task.user_id = 7
    mock_task.kind = "Task"
    mock_task.is_active = TaskResource.STATE_ACTIVE
    mock_task.json = {"kind": "Task"}

    mock_task_query = Mock()
    mock_task_query.filter.return_value = mock_task_query
    mock_task_query.first.return_value = mock_task
    db.query.return_value = mock_task_query

    task_crd = SimpleNamespace(
        spec=SimpleNamespace(
            teamRef=SimpleNamespace(name="missing-team", namespace="team-a"),
        ),
        metadata=SimpleNamespace(
            labels={
                "requestedSkillRefs": json.dumps(
                    [
                        {
                            "name": "manual-skill",
                            "namespace": "team-a",
                            "is_public": False,
                        }
                    ]
                )
            }
        ),
    )

    with (
        patch(
            "app.services.task_member_service.task_member_service.is_member",
            return_value=True,
        ),
        patch(
            "app.services.readers.kinds.kindReader.get_by_name_and_namespace",
            return_value=None,
        ),
        patch(
            "app.services.adapters.task_kinds.task_skills_resolver.Task.model_validate",
            return_value=task_crd,
        ),
        patch(
            "app.services.adapters.task_kinds.task_skills_resolver.find_skill_by_ref",
            return_value=SimpleNamespace(id=22, namespace="team-a", user_id=7),
        ),
    ):
        result = resolve_task_skills(db, task_id=123, user_id=99)

    assert result["skills"] == ["manual-skill"]
    assert result["preload_skills"] == ["manual-skill"]
    assert result["skill_refs"]["manual-skill"]["skill_id"] == 22
    assert result["preload_skill_refs"]["manual-skill"]["skill_id"] == 22


@pytest.mark.unit
@pytest.mark.parametrize("skill_id, expected_user_id", [(None, 7), (55, 99)])
def test_resolve_task_skills_authorizes_requested_skill_identity(
    skill_id, expected_user_id
):
    db = Mock(spec=Session)

    mock_task = Mock(spec=TaskResource)
    mock_task.id = 123
    mock_task.user_id = 99
    mock_task.kind = "Task"
    mock_task.is_active = TaskResource.STATE_ACTIVE
    mock_task.json = {"kind": "Task"}

    mock_task_query = Mock()
    mock_task_query.filter.return_value = mock_task_query
    mock_task_query.first.return_value = mock_task
    db.query.return_value = mock_task_query

    task_crd = SimpleNamespace(
        spec=SimpleNamespace(
            teamRef=SimpleNamespace(name="shared-team", namespace="default", user_id=7),
        ),
        metadata=SimpleNamespace(
            labels={
                "requestedSkillRefs": json.dumps(
                    [
                        {
                            "name": "owner-private-skill",
                            "namespace": "default",
                            "is_public": False,
                            "skill_id": skill_id,
                        }
                    ]
                )
            }
        ),
    )
    team_crd = SimpleNamespace(spec=SimpleNamespace(members=[]))
    shared_team = _build_kind(7, {"kind": "Team", "name": "shared-team"})

    with (
        patch(
            "app.services.task_member_service.task_member_service.is_member",
            return_value=True,
        ),
        patch(
            "app.services.readers.kinds.kindReader.get_by_name_and_namespace",
            return_value=shared_team,
        ),
        patch(
            "app.services.adapters.task_kinds.task_skills_resolver.Task.model_validate",
            return_value=task_crd,
        ),
        patch(
            "app.services.adapters.task_kinds.task_skills_resolver.Team.model_validate",
            return_value=team_crd,
        ),
        patch(
            "app.services.adapters.task_kinds.task_skills_resolver.find_skill_by_ref",
            return_value=SimpleNamespace(id=55, namespace="default", user_id=7),
        ) as mock_find_skill_by_ref,
    ):
        result = resolve_task_skills(db, task_id=123, user_id=99)

    assert result["skill_refs"]["owner-private-skill"]["skill_id"] == 55
    assert result["preload_skill_refs"]["owner-private-skill"]["skill_id"] == 55
    assert mock_find_skill_by_ref.call_args.kwargs["user_id"] == expected_user_id
    assert mock_find_skill_by_ref.call_args.kwargs["skill_id"] == skill_id
