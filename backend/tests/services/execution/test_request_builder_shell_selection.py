# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Skill selections survive runtime request compilation across Shell types."""

from copy import deepcopy
from types import SimpleNamespace

import pytest

from app.services.execution.request_builder import TaskRequestBuilder
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
        name="device-ghost",
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
    base_ghost = SimpleNamespace(
        name="base-ghost",
        namespace="default",
        json={
            "kind": "Ghost",
            "metadata": {"name": "base-ghost", "namespace": "default"},
            "spec": {
                "systemPrompt": "Use shared sandbox capabilities.",
                "skills": ["sandbox"],
                "skill_refs": {"sandbox": {"skill_id": 1540, "is_public": True}},
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
        1540: skill("sandbox", 1540, 0, ["Chat"], "Sandbox tools"),
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
    default_skill_ids = {
        "browser": 1286,
        "document": 1279,
        "interactive": interactive.id,
        "sandbox": 1540,
    }
    mocker.patch(
        "app.services.execution.request_builder.Team.model_validate",
        return_value=SimpleNamespace(spec=SimpleNamespace(collaborationModel="solo")),
    )
    mocker.patch(
        "app.services.ghost_capabilities.kindReader.get_by_name_and_namespace",
        side_effect=lambda *args: base_ghost if args[-1] == "base-ghost" else ghost,
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
            skill_id or default_skill_ids[name]
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
        inherit_base=False,
        base_preload=False,
    ):
        if missing_browser:
            del skills[1286]
        if required:
            ghost.json["spec"]["preload_skills"] = ["browser"]
        if preload_ref:
            ghost.json["spec"]["preload_skill_refs"] = {"browser": preload_ref}
        if inherit_base:
            ghost.json["spec"]["baseGhostRef"] = {
                "name": "base-ghost",
                "namespace": "default",
                "user_id": 0,
            }
        if base_preload:
            base_ghost.json["spec"]["preload_skills"] = ["sandbox"]
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
                    "skills": ["browser", "document"]
                    + (["sandbox"] if inherit_base else []),
                    "preload_skills": (["browser"] if required else [])
                    + (["sandbox"] if base_preload else []),
                    "skill_refs": {
                        **deepcopy(ghost.json["spec"]["skill_refs"]),
                        **(
                            deepcopy(base_ghost.json["spec"]["skill_refs"])
                            if inherit_base
                            else {}
                        ),
                    },
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


def test_codex_selected_private_skill_keeps_its_package_and_binding(selection_builder):
    skill = selection_builder.interactive
    skill.user_id = selection_builder.user.id

    result = selection_builder.build(
        "Codex", selected=[{"name": skill.name, "skill_id": skill.id}]
    )

    assert skill.name in result.preload_skills
    assert result.skill_refs[skill.name]["skill_id"] == skill.id
    assert result.skill_refs[skill.name]["bind_shells"] == [
        "Chat",
        "Agno",
        "ClaudeCode",
    ]
    config = next(item for item in result.skill_configs if item["name"] == skill.name)
    assert config["prompt"] == "Ask a question"
    assert config["bindShells"] == result.skill_refs[skill.name]["bind_shells"]
    assert result.bot[0]["skill_refs"][skill.name] == result.skill_refs[skill.name]


@pytest.mark.parametrize("shell", ["Chat", "ClaudeCode", "Codex"])
def test_runtime_request_keeps_configured_skill_content_and_mcp(
    selection_builder, shell
):
    result = selection_builder.build(shell)
    assert result.bot[0]["shell_type"] == shell
    assert result.skill_names == ["browser", "document"]
    assert [skill["name"] for skill in result.skill_configs] == ["browser", "document"]
    assert result.skill_configs[0]["prompt"] == "Chat sandbox browser"
    assert result.skill_refs["browser"]["skill_id"] == 1286
    assert result.skill_refs["browser"]["bind_shells"] == ["Chat"]
    assert result.bot[0]["skills"] == ["browser", "document"]
    assert result.bot[0]["skill_refs"]["browser"] == result.skill_refs["browser"]
    if shell != "Chat":
        assert [server["name"] for server in result.bot[0]["mcp_servers"]] == [
            "browser",
            "document",
        ]
    assert not result.preload_skills


@pytest.mark.parametrize("required", [False, True])
def test_explicit_and_ghost_preloads_keep_skill_content(selection_builder, required):
    selected = (
        None if required else [{"name": "browser", "skill_id": 1286, "is_public": True}]
    )
    result = selection_builder.build(selected=selected, required=required)

    assert result.preload_skills == ["browser"]
    assert result.user_selected_skills == ["browser"]
    assert result.preload_skill_refs["browser"] == result.skill_refs["browser"]
    assert result.preload_skill_refs["browser"]["skill_id"] == 1286
    assert result.skill_configs[0]["prompt"] == "Chat sandbox browser"
    assert result.bot[0]["skill_refs"]["browser"] == result.skill_refs["browser"]
    assert any(server["name"] == "browser" for server in result.bot[0]["mcp_servers"])


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


def test_late_preload_keeps_existing_skill_content_and_mcp(selection_builder):
    result = selection_builder.build()
    result.preload_skills = ["sandbox"]
    result = selection_builder.builder.resolve_request_preload_skills(
        request=result,
        bot=selection_builder.bot,
        team=selection_builder.team,
        user=selection_builder.user,
    )
    assert result.skill_names == ["browser", "document", "sandbox"]
    assert result.preload_skills == ["sandbox"]
    assert result.preload_skill_refs["sandbox"]["skill_id"] == 1540
    assert result.skill_configs[0]["prompt"] == "Chat sandbox browser"
    assert result.skill_configs[2]["prompt"] == "Sandbox tools"
    assert result.bot[0]["skill_refs"]["browser"] == result.skill_refs["browser"]
    assert result.bot[0]["skill_refs"]["sandbox"] == result.skill_refs["sandbox"]
    assert [server["name"] for server in result.bot[0]["mcp_servers"]] == [
        "browser",
        "document",
        "sandbox",
    ]


def test_existing_skill_preload_preserves_native_request(selection_builder):
    result = selection_builder.build()
    result.preload_skills = ["browser"]

    resolved = selection_builder.builder.resolve_request_preload_skills(
        request=result,
        bot=selection_builder.bot,
        team=selection_builder.team,
        user=selection_builder.user,
    )

    assert resolved is result
    assert resolved.bot[0]["shell_type"] == "ClaudeCode"
    assert resolved.skill_names == ["browser", "document"]
    assert resolved.preload_skills == ["browser"]
    assert resolved.skill_configs[0]["prompt"] == "Chat sandbox browser"
    assert resolved.skill_refs["browser"]["skill_id"] == 1286
    assert resolved.bot[0]["skill_refs"]["browser"] == resolved.skill_refs["browser"]
    assert [server["name"] for server in resolved.bot[0]["mcp_servers"]] == [
        "browser",
        "document",
    ]


def test_explicit_selected_name_is_preserved(selection_builder):
    result = selection_builder.build(selected_names=["browser"])

    assert result.user_selected_skills == ["browser"]
    assert result.skill_refs["browser"]["skill_id"] == 1286
    assert result.skill_configs[0]["prompt"] == "Chat sandbox browser"


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
def test_coordinate_member_skills_reach_the_leader(selection_builder, required):
    member = {
        "name": "chat-reviewer",
        "shell_type": "Chat",
        "skills": ["sandbox"],
        "preload_skills": ["sandbox"] if required else [],
        "skill_refs": {"sandbox": {"skill_id": 1540, "is_public": True}},
    }
    result = selection_builder.build(collaboration="coordinate", members=[member])

    assert result.skill_names == ["browser", "document", "sandbox"]
    assert result.skill_configs[2]["prompt"] == "Sandbox tools"
    assert all("sandbox" in config["skills"] for config in result.bot)
    assert all(
        config["skill_refs"]["sandbox"]["skill_id"] == 1540 for config in result.bot
    )
    assert result.bot[1]["preload_skills"] == (["sandbox"] if required else [])
    assert any(server["name"] == "sandbox" for server in result.bot[0]["mcp_servers"])


@pytest.mark.parametrize("shell", ["Chat", "ClaudeCode", "Codex"])
@pytest.mark.parametrize("force_preload", [False, True])
def test_automatic_default_skill_reaches_each_runtime(
    selection_builder, mocker, shell, force_preload
):
    mocker.patch(
        "app.services.execution.request_builder.skill_binding_service.list_user_default_skill_refs",
        return_value=[
            {
                "name": "sandbox",
                "skill_id": 1540,
                "namespace": "default",
                "is_public": True,
                "bind_shells": ["Chat"],
                "force_preload": force_preload,
            }
        ],
    )
    result = selection_builder.build(shell)
    assert result.bot[0]["shell_type"] == shell
    assert result.skill_names == ["browser", "document", "sandbox"]
    assert result.skill_refs["sandbox"]["skill_id"] == 1540
    assert result.skill_configs[2]["prompt"] == "Sandbox tools"
    assert result.bot[0]["skill_refs"]["sandbox"] == result.skill_refs["sandbox"]
    assert ("sandbox" in result.preload_skills) == force_preload
    if force_preload:
        assert result.preload_skill_refs["sandbox"] == result.skill_refs["sandbox"]
    if shell != "Chat":
        assert any(
            server["name"] == "sandbox" for server in result.bot[0]["mcp_servers"]
        )


@pytest.mark.parametrize("base_preload", [False, True])
def test_inherited_sandbox_reaches_native_runtime(selection_builder, base_preload):
    result = selection_builder.build(inherit_base=True, base_preload=base_preload)

    assert result.bot[0]["shell_type"] == "ClaudeCode"
    assert "sandbox" in result.skill_names
    config = next(skill for skill in result.skill_configs if skill["name"] == "sandbox")
    assert config["prompt"] == "Sandbox tools"
    assert config["bindShells"] == ["Chat"]
    assert result.skill_refs["sandbox"]["skill_id"] == 1540
    assert result.bot[0]["skill_refs"]["sandbox"] == result.skill_refs["sandbox"]
    assert "sandbox" in result.bot[0]["skills"]
    assert ("sandbox" in result.preload_skills) == base_preload
    if base_preload:
        assert result.preload_skill_refs["sandbox"] == result.skill_refs["sandbox"]
    assert any(server["name"] == "sandbox" for server in result.bot[0]["mcp_servers"])
