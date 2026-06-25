# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace
from unittest.mock import Mock, patch

from app.services.chat.storage.task_manager import TaskCreationParams, create_new_task


def _make_team():
    team = Mock()
    team.user_id = 7
    team.name = "team-alpha"
    team.namespace = "default"
    team.json = {
        "kind": "Team",
        "apiVersion": "agent.wecode.io/v1",
        "metadata": {"name": "team-alpha", "namespace": "default"},
        "spec": {
            "collaborationModel": "coordinate",
            "members": [
                {"botRef": {"name": "bot-one", "namespace": "default"}},
                {"botRef": {"name": "bot-two", "namespace": "default"}},
            ],
        },
        "status": {"state": "Available"},
    }
    return team


def _make_user():
    user = Mock()
    user.id = 7
    user.user_name = "alice"
    return user


def _make_bot(name: str, ghost_name: str):
    bot = Mock()
    bot.json = {
        "kind": "Bot",
        "apiVersion": "agent.wecode.io/v1",
        "metadata": {"name": name, "namespace": "default"},
        "spec": {
            "ghostRef": {"name": ghost_name, "namespace": "default"},
            "shellRef": {"name": "ClaudeCode", "namespace": "default"},
            "modelRef": {"name": f"{name}-model", "namespace": "default"},
        },
        "status": {"state": "Available"},
    }
    return bot


def _make_ghost(name: str, refs: list[dict]):
    ghost = Mock()
    ghost.json = {
        "kind": "Ghost",
        "apiVersion": "agent.wecode.io/v1",
        "metadata": {"name": name, "namespace": "default"},
        "spec": {
            "systemPrompt": "hello",
            "mcpServers": {},
            "defaultKnowledgeBaseRefs": refs,
        },
        "status": {"state": "Available"},
    }
    return ghost


def _make_kb(kb_id: int, name: str):
    kb = Mock()
    kb.id = kb_id
    kb.name = f"kb-{kb_id}"
    kb.kind = "KnowledgeBase"
    kb.namespace = "default"
    kb.is_active = True
    kb.json = {"spec": {"name": name}}
    return kb


def _make_task_resource(user_id: int = 7, team_user_id: int = 7):
    task = Mock()
    task.id = 1001
    task.user_id = user_id
    task.json = {
        "kind": "Task",
        "apiVersion": "agent.wecode.io/v1",
        "metadata": {"name": "task-alpha", "namespace": "default"},
        "spec": {
            "title": "Task Alpha",
            "prompt": "hello",
            "teamRef": {
                "name": "team-alpha",
                "namespace": "default",
                "user_id": team_user_id,
            },
            "workspaceRef": {"name": "workspace", "namespace": "default"},
        },
        "status": {"phase": "pending"},
    }
    return task


def test_get_task_team_preserves_public_owner_zero(test_db):
    from app.models.kind import Kind
    from app.schemas.kind import Task
    from app.services.chat.task_default_knowledge_bases import _get_task_team

    public_team = Kind(
        user_id=0,
        kind="Team",
        name="team-alpha",
        namespace="default",
        json={"kind": "Team", "metadata": {"name": "team-alpha"}},
        is_active=True,
    )
    private_same_name_team = Kind(
        user_id=7,
        kind="Team",
        name="team-alpha",
        namespace="default",
        json={"kind": "Team", "metadata": {"name": "team-alpha"}},
        is_active=True,
    )
    test_db.add_all([public_team, private_same_name_team])
    test_db.commit()
    test_db.refresh(public_team)

    task = _make_task_resource(user_id=7, team_user_id=0)
    task_crd = Task.model_validate(task.json)

    team = _get_task_team(test_db, task, task_crd)

    assert team.id == public_team.id
    assert team.user_id == 0


def test_build_initial_task_knowledge_base_refs_only_uses_explicit_selection():
    from app.services.chat.task_default_knowledge_bases import (
        build_initial_task_knowledge_base_refs,
    )

    db = Mock()
    team = _make_team()
    user = _make_user()
    kb_map = {
        11: _make_kb(11, "Product Docs"),
        22: _make_kb(22, "Runbooks"),
        33: _make_kb(33, "Release Notes"),
    }

    with patch(
        "app.services.chat.task_default_knowledge_bases._get_accessible_knowledge_base",
        side_effect=lambda _db, _user_id, kb_id: kb_map.get(kb_id),
    ):
        refs = build_initial_task_knowledge_base_refs(
            db=db,
            user=user,
            team=team,
            knowledge_base_id=33,
        )

    assert [ref["id"] for ref in refs] == [33]


def test_build_initial_task_knowledge_base_refs_returns_empty_without_explicit_kb():
    from app.services.chat.task_default_knowledge_bases import (
        build_initial_task_knowledge_base_refs,
    )

    db = Mock()
    team = _make_team()
    user = _make_user()

    refs = build_initial_task_knowledge_base_refs(
        db=db,
        user=user,
        team=team,
    )

    assert refs == []


def test_build_initial_task_knowledge_base_refs_skips_inaccessible_refs():
    from app.services.chat.task_default_knowledge_bases import (
        build_initial_task_knowledge_base_refs,
    )

    db = Mock()
    team = _make_team()
    user = _make_user()

    with patch(
        "app.services.chat.task_default_knowledge_bases._get_accessible_knowledge_base",
        side_effect=lambda _db, _user_id, kb_id: (
            _make_kb(11, "Product Docs") if kb_id == 11 else None
        ),
    ):
        refs = build_initial_task_knowledge_base_refs(
            db=db,
            user=user,
            team=team,
            knowledge_base_id=22,
        )

    assert refs == []


def test_get_task_default_knowledge_base_scopes_uses_runtime_agent_config():
    from app.services.chat.task_default_knowledge_bases import (
        get_task_default_knowledge_base_scopes,
    )

    db = Mock()
    query = Mock()
    query.filter.return_value = query
    query.first.return_value = _make_task_resource()
    db.query.return_value = query
    team = _make_team()
    kb_map = {
        11: _make_kb(11, "Product Docs"),
        22: _make_kb(22, "Runbooks"),
    }

    def _kind_lookup(_, __, kind_type, ___, name):
        if kind_type.value == "Bot":
            return {
                "bot-one": _make_bot("bot-one", "ghost-one"),
                "bot-two": _make_bot("bot-two", "ghost-two"),
            }.get(name)
        return {
            "ghost-one": _make_ghost(
                "ghost-one",
                [{"id": 11, "name": "Product Docs", "grantPrincipalUserId": 7}],
            ),
            "ghost-two": _make_ghost(
                "ghost-two",
                [
                    {"id": 11, "name": "Product Docs", "grantPrincipalUserId": 7},
                    {"id": 22, "name": "Runbooks", "grantPrincipalUserId": 7},
                ],
            ),
        }.get(name)

    with patch(
        "app.services.chat.task_default_knowledge_bases._get_task_team",
        return_value=team,
    ):
        with patch(
            "app.services.chat.task_default_knowledge_bases.kindReader.get_by_name_and_namespace",
            side_effect=_kind_lookup,
        ):
            with patch(
                "app.services.chat.task_default_knowledge_bases._get_default_knowledge_base",
                side_effect=lambda _db, kb_id: kb_map.get(kb_id),
            ):
                with patch(
                    "app.services.chat.task_default_knowledge_bases._can_grant_principal_read_kb",
                    return_value=True,
                ):
                    scopes = get_task_default_knowledge_base_scopes(
                        db, task_id=1001, user_id=7
                    )

    assert [scope.knowledge_base_id for scope in scopes] == [11, 22]
    assert all(not scope.scope_restricted for scope in scopes)


def test_get_task_default_knowledge_base_scopes_rejects_public_private_kb():
    from app.services.chat.task_default_knowledge_bases import (
        get_task_default_knowledge_base_scopes,
    )

    db = Mock()
    query = Mock()
    query.filter.return_value = query
    query.first.return_value = _make_task_resource(user_id=9, team_user_id=0)
    db.query.return_value = query
    team = _make_team()
    team.user_id = 0
    org_kb = _make_kb(11, "Company Docs")
    org_kb.namespace = "company"
    private_kb = _make_kb(22, "Private Docs")

    def _kind_lookup(_, __, kind_type, ___, name):
        if kind_type.value == "Bot":
            return _make_bot("bot-one", "ghost-one")
        return _make_ghost(
            "ghost-one",
            [
                {"id": 11, "name": "Company Docs"},
                {"id": 22, "name": "Private Docs"},
            ],
        )

    with patch(
        "app.services.chat.task_default_knowledge_bases._get_task_team",
        return_value=team,
    ):
        with patch(
            "app.services.chat.task_default_knowledge_bases.kindReader.get_by_name_and_namespace",
            side_effect=_kind_lookup,
        ):
            with patch(
                "app.services.chat.task_default_knowledge_bases._get_default_knowledge_base",
                side_effect=lambda _db, kb_id: {11: org_kb, 22: private_kb}.get(kb_id),
            ):
                with patch(
                    "app.services.chat.task_default_knowledge_bases._can_use_public_default_kb",
                    side_effect=lambda _db, kb: kb.id == 11,
                ):
                    scopes = get_task_default_knowledge_base_scopes(
                        db, task_id=1001, user_id=9
                    )

    assert [scope.knowledge_base_id for scope in scopes] == [11]


def test_get_task_default_knowledge_base_scopes_requires_agent_permission():
    from app.services.chat.task_default_knowledge_bases import (
        get_task_default_knowledge_base_scopes,
    )

    db = Mock()
    query = Mock()
    query.filter.return_value = query
    query.first.return_value = _make_task_resource(user_id=9, team_user_id=7)
    db.query.return_value = query
    team = _make_team()
    team.user_id = 7

    with patch(
        "app.services.chat.task_default_knowledge_bases._get_task_team",
        return_value=team,
    ):
        with patch(
            "app.services.chat.task_default_knowledge_bases._can_user_use_team",
            return_value=False,
        ):
            scopes = get_task_default_knowledge_base_scopes(db, task_id=1001, user_id=9)

    assert scopes == []


def test_create_new_task_writes_initial_knowledge_base_refs_for_chat_tasks(
    test_db, test_user
):
    team = SimpleNamespace(
        id=1256,
        user_id=test_user.id,
        name="team-alpha",
        namespace="default",
    )
    params = TaskCreationParams(
        message="hello",
        task_type="chat",
    )

    with patch(
        "app.services.chat.storage.task_manager.build_initial_task_knowledge_base_refs",
        return_value=[
            {"id": 11, "name": "Product Docs", "boundBy": "alice"},
            {"id": 22, "name": "Runbooks", "boundBy": "alice"},
        ],
    ):
        task = create_new_task(
            db=test_db,
            user=test_user,
            team=team,
            params=params,
        )

    assert [ref["id"] for ref in task.json["spec"]["knowledgeBaseRefs"]] == [11, 22]
