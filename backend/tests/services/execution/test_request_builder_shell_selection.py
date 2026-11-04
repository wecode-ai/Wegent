# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Runtime requests project optional defaults onto the executing Shell."""

from copy import deepcopy
from types import SimpleNamespace

import pytest

from app.schemas.kind import Ghost
from app.services.execution.request_builder import TaskRequestBuilder
from app.services.ghost_capabilities import merge_ghost_capabilities
from app.services.skill_runtime import SkillShellMismatchError
from shared.models.db import User


@pytest.fixture
def selection_builder(test_db, mocker):
    test_db.add(User(id=7, user_name="alice", password_hash="unused"))
    test_db.flush()
    builder = TaskRequestBuilder(test_db)
    team = SimpleNamespace(
        id=5, user_id=0, name="wegent-wework", namespace="default", json={}
    )
    user = SimpleNamespace(id=7, user_name="alice")
    bot = SimpleNamespace(
        id=9,
        name="device-bot",
        json={
            "kind": "Bot",
            "metadata": {"name": "device-bot", "namespace": "default"},
            "spec": {
                "ghostRef": {"name": "device-ghost", "namespace": "default"},
                "shellRef": {"name": "ClaudeCode", "namespace": "default"},
            },
        },
    )
    ghost = SimpleNamespace(
        namespace="default",
        json={
            "kind": "Ghost",
            "metadata": {"name": "device-ghost", "namespace": "default"},
            "spec": {
                "systemPrompt": "Use available skills.",
                "skills": ["browser", "document"],
                "skill_refs": {
                    "browser": {"skill_id": 1286, "is_public": True},
                    "document": {"skill_id": 1279, "is_public": True},
                },
            },
        },
    )

    def skill(name, skill_id, owner, shells, prompt):
        return SimpleNamespace(
            id=skill_id,
            name=name,
            user_id=owner,
            namespace="default",
            json={
                "kind": "Skill",
                "metadata": {"name": name, "namespace": "default"},
                "spec": {
                    "description": name,
                    "prompt": prompt,
                    "bindShells": shells,
                    "mcpServers": {name: {"command": name + "-mcp", "type": "stdio"}},
                },
            },
        )

    skills = {
        1286: skill("browser", 1286, 0, ["Chat"], "Chat sandbox browser"),
        1279: skill("document", 1279, 0, ["Chat", "ClaudeCode", "Codex"], "Documents"),
        1336: skill("browser", 1336, 7, ["ClaudeCode"], "Native CDP browser"),
    }
    interactive = skill(
        "interactive", 1500, 0, ["Chat", "Agno", "ClaudeCode"], "Ask a question"
    )
    interactive.json["spec"]["mcpServers"] = {
        "wegent-interactive-form-question": {
            "type": "streamable-http",
            "url": "https://example.test/mcp/interactive-form-question/sse",
        }
    }
    skills[interactive.id] = interactive
    mocker.patch(
        "app.services.execution.request_builder.Team.model_validate",
        return_value=SimpleNamespace(spec=SimpleNamespace(collaborationModel="solo")),
    )
    mocker.patch.object(builder, "_get_bot_ghost_chain", return_value=[ghost])
    mocker.patch.object(
        builder,
        "_get_bot_ghost_capabilities",
        side_effect=lambda *args: merge_ghost_capabilities(
            [(ghost, Ghost.model_validate(ghost.json))]
        ),
    )
    mocker.patch.object(
        builder,
        "_find_attached_skill_by_ref",
        side_effect=lambda name, *, skill_id: skills.get(skill_id),
    )
    mocker.patch.object(
        builder,
        "_find_skill_by_ref",
        side_effect=lambda name, *args, skill_id=None, **kwargs: skills.get(
            skill_id or (interactive.id if name == interactive.name else 1286)
        ),
    )
    for method, value in {
        "_get_bot_for_subtask": bot,
        "_build_workspace": {},
        "_build_user_info": {"id": 7},
        "_get_model_config": {},
        "_get_base_system_prompt": "Use available skills.",
        "_inject_subscription_manager_skill": [],
        "_build_mcp_servers": [],
        "_is_group_chat": False,
        "_generate_auth_token": "task-jwt",
        "_generate_skill_identity_token": "skill-jwt",
    }.items():
        mocker.patch.object(builder, method, return_value=value)
    mocker.patch.object(
        builder,
        "_inject_conditional_provider_skills",
        side_effect=lambda **kwargs: kwargs["preload_skills"],
    )

    def build(
        shell="ClaudeCode",
        *,
        selected=None,
        required=False,
        selected_names=None,
        collaboration="solo",
        members=(),
        preload_ref=None,
        missing_browser=False,
        clarification=False,
    ):
        if missing_browser:
            del skills[1286]
        if required:
            ghost.json["spec"]["preload_skills"] = ["browser"]
        if preload_ref:
            ghost.json["spec"]["preload_skill_refs"] = {"browser": preload_ref}
        mocker.patch(
            "app.services.execution.request_builder.Team.model_validate",
            return_value=SimpleNamespace(
                spec=SimpleNamespace(collaborationModel=collaboration)
            ),
        )
        mocker.patch.object(
            builder,
            "_build_bot_config",
            return_value=[
                {
                    "id": 9,
                    "name": "device-bot",
                    "shell_type": shell,
                    "skills": ["browser", "document"],
                    "preload_skills": ["browser"] if required else [],
                    "skill_refs": deepcopy(ghost.json["spec"]["skill_refs"]),
                    "mcp_servers": [],
                },
                *deepcopy(members),
            ],
        )
        return builder.build(
            subtask=SimpleNamespace(id=2, message_id=33),
            task=SimpleNamespace(id=1, user_id=7, json={"spec": {}}, project_id=None),
            user=user,
            team=team,
            message="List my skills",
            preload_skills=selected,
            user_selected_skills=selected_names,
            enable_clarification=clarification,
        )

    return SimpleNamespace(
        build=build,
        builder=builder,
        bot=bot,
        team=team,
        user=user,
        interactive=interactive,
    )


def test_codex_clarification_uses_existing_builtin_skill_without_changing_it(
    selection_builder,
):
    skill = selection_builder.interactive
    stored_spec = deepcopy(skill.json["spec"])

    result = selection_builder.build("Codex", clarification=True)

    assert "interactive" in result.preload_skills
    assert result.skill_refs["interactive"]["skill_id"] == skill.id
    assert "Codex" in result.bot[0]["skill_refs"]["interactive"]["bind_shells"]
    assert any(
        server.get("url") == "https://example.test/mcp/interactive-form-question/sse"
        for server in result.bot[0]["mcp_servers"]
    )
    assert skill.json["spec"] == stored_spec


def test_codex_respects_shells_of_a_same_name_private_skill(selection_builder):
    skill = selection_builder.interactive
    skill.user_id = selection_builder.user.id

    with pytest.raises(SkillShellMismatchError, match="interactive.*Codex"):
        selection_builder.build(
            "Codex", selected=[{"name": skill.name, "skill_id": skill.id}]
        )


@pytest.mark.parametrize("shell", ["ClaudeCode", "Codex"])
def test_native_request_excludes_optional_chat_default_everywhere(
    selection_builder, shell
):
    result = selection_builder.build(shell)
    assert result.skill_names == ["document"]
    assert [skill["name"] for skill in result.skill_configs] == ["document"]
    assert list(result.skill_refs) == ["document"]
    assert result.bot[0]["skills"] == ["document"]
    assert list(result.bot[0]["skill_refs"]) == ["document"]
    assert [server["name"] for server in result.bot[0]["mcp_servers"]] == ["document"]
    assert not result.preload_skills


def test_chat_request_keeps_its_browser_default(selection_builder):
    result = selection_builder.build("Chat")
    assert result.skill_names == ["browser", "document"]
    assert result.skill_refs["browser"]["skill_id"] == 1286


@pytest.mark.parametrize("required", [False, True])
def test_required_incompatible_skill_is_rejected(selection_builder, required):
    selected = (
        None if required else [{"name": "browser", "skill_id": 1286, "is_public": True}]
    )
    with pytest.raises(SkillShellMismatchError, match="browser.*ClaudeCode"):
        selection_builder.build(selected=selected, required=required)


def test_explicit_same_name_selection_uses_matching_content_and_identity(
    selection_builder,
):
    result = selection_builder.build(selected=[{"name": "browser", "skill_id": 1336}])
    browser = next(
        skill for skill in result.skill_configs if skill["name"] == "browser"
    )
    assert browser["skill_id"] == 1336
    assert browser["prompt"] == "Native CDP browser"
    assert browser["bindShells"] == ["ClaudeCode"]
    assert result.skill_refs["browser"]["skill_id"] == 1336
    assert result.preload_skill_refs["browser"]["skill_id"] == 1336
    assert result.bot[0]["skill_refs"]["browser"]["skill_id"] == 1336


def test_late_preload_does_not_restore_incompatible_default(selection_builder):
    result = selection_builder.build()
    result.preload_skills = ["document"]
    result.skill_names = []
    result = selection_builder.builder.resolve_request_preload_skills(
        request=result,
        bot=selection_builder.bot,
        team=selection_builder.team,
        user=selection_builder.user,
    )
    assert result.skill_names == ["document"]
    assert "browser" not in result.bot[0]["skills"]
    assert "browser" not in result.skill_refs


def test_explicit_selected_name_remains_required(selection_builder):
    with pytest.raises(SkillShellMismatchError, match="browser.*ClaudeCode"):
        selection_builder.build(selected_names=["browser"])


def test_ghost_preload_reference_overrides_same_name_content(selection_builder):
    result = selection_builder.build(required=True, preload_ref={"skill_id": 1336})
    browser = next(
        skill for skill in result.skill_configs if skill["name"] == "browser"
    )
    assert browser["skill_id"] == 1336
    assert browser["prompt"] == "Native CDP browser"
    assert result.bot[0]["skill_refs"]["browser"]["skill_id"] == 1336


def test_unresolved_required_skill_is_not_silently_dropped(selection_builder):
    result = selection_builder.build(required=True, missing_browser=True)
    assert "browser" in result.bot[0]["skills"]
    assert "browser" in result.bot[0]["preload_skills"]
    assert result.bot[0]["skill_refs"]["browser"]["skill_id"] == 1286


@pytest.mark.parametrize("required", [False, True])
def test_coordinate_member_defaults_use_actual_execution_shell(
    selection_builder, required
):
    member = {
        "name": "chat-reviewer",
        "shell_type": "Chat",
        "skills": ["browser"],
        "preload_skills": ["browser"] if required else [],
        "skill_refs": {"browser": {"skill_id": 1286, "is_public": True}},
    }
    if required:
        with pytest.raises(SkillShellMismatchError, match="browser.*ClaudeCode"):
            selection_builder.build(collaboration="coordinate", members=[member])
    else:
        result = selection_builder.build(collaboration="coordinate", members=[member])
        assert result.skill_names == ["document"]
        assert all("browser" not in bot["skills"] for bot in result.bot)


@pytest.mark.parametrize("shell", ["Chat", "ClaudeCode", "Codex"])
def test_automatic_force_preload_applies_only_to_compatible_shell(
    selection_builder, mocker, shell
):
    mocker.patch(
        "app.services.execution.request_builder.skill_binding_service.list_user_default_skill_refs",
        return_value=[
            {
                "name": "browser",
                "skill_id": 1286,
                "namespace": "default",
                "is_public": True,
                "bind_shells": ["Chat"],
                "force_preload": True,
            }
        ],
    )
    mocker.patch.object(
        selection_builder.builder,
        "_resolve_shell_info",
        return_value={"shell_type": shell},
    )
    result = selection_builder.build(shell)
    assert ("browser" in result.preload_skills) == (shell == "Chat")
