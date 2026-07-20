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


def test_build_initial_task_knowledge_base_refs_persists_only_explicit_selection():
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

    def _kind_lookup(_, __, kind_type, ___, name):
        if kind_type.value == "Bot":
            return {
                "bot-one": _make_bot("bot-one", "ghost-one"),
                "bot-two": _make_bot("bot-two", "ghost-two"),
            }.get(name)
        return {
            "ghost-one": _make_ghost("ghost-one", [{"id": 11, "name": "Product Docs"}]),
            "ghost-two": _make_ghost("ghost-two", [{"id": 22, "name": "Runbooks"}]),
        }.get(name)

    with patch(
        "app.services.chat.task_default_knowledge_bases.kindReader.get_by_name_and_namespace",
        side_effect=_kind_lookup,
    ):
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


def test_build_initial_task_knowledge_base_refs_does_not_snapshot_agent_defaults():
    from app.services.chat.task_default_knowledge_bases import (
        build_initial_task_knowledge_base_refs,
    )

    db = Mock()
    team = _make_team()
    user = _make_user()
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
            "ghost-one": _make_ghost("ghost-one", [{"id": 11, "name": "Product Docs"}]),
            "ghost-two": _make_ghost(
                "ghost-two",
                [
                    {"id": 11, "name": "Product Docs"},
                    {"id": 22, "name": "Runbooks"},
                ],
            ),
        }.get(name)

    with patch(
        "app.services.chat.task_default_knowledge_bases.kindReader.get_by_name_and_namespace",
        side_effect=_kind_lookup,
    ):
        with patch(
            "app.services.chat.task_default_knowledge_bases._get_accessible_knowledge_base",
            side_effect=lambda _db, _user_id, kb_id: kb_map.get(kb_id),
        ):
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

    def _kind_lookup(_, __, kind_type, ___, name):
        if kind_type.value == "Bot":
            return {
                "bot-one": _make_bot("bot-one", "ghost-one"),
                "bot-two": _make_bot("bot-two", "ghost-two"),
            }.get(name)
        return {
            "ghost-one": _make_ghost("ghost-one", [{"id": 11, "name": "Product Docs"}]),
            "ghost-two": _make_ghost("ghost-two", [{"id": 22, "name": "Secret Docs"}]),
        }.get(name)

    with patch(
        "app.services.chat.task_default_knowledge_bases.kindReader.get_by_name_and_namespace",
        side_effect=_kind_lookup,
    ):
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


def test_resolve_task_defaults_uses_current_agent_configuration():
    from app.services.chat.task_default_knowledge_bases import (
        resolve_task_default_knowledge_base_ids,
    )

    db = Mock()
    task = SimpleNamespace(json={"kind": "Task"})
    task_crd = SimpleNamespace()
    team = SimpleNamespace(id=42)
    query = db.query.return_value
    query.filter.return_value = query
    query.all.return_value = [(11,), (22,)]

    with (
        patch(
            "app.services.chat.task_default_knowledge_bases.task_store.get_active_task",
            return_value=task,
        ),
        patch(
            "app.services.chat.task_default_knowledge_bases.Task.model_validate",
            return_value=task_crd,
        ),
        patch(
            "app.services.chat.task_default_knowledge_bases.resolve_task_ref_team",
            return_value=team,
        ),
        patch(
            "app.services.chat.task_default_knowledge_bases.team_share_service.get_resource",
            return_value=team,
        ),
        patch(
            "app.services.chat.task_default_knowledge_bases._iter_team_member_default_knowledge_base_ids",
            return_value=[11, 22, 11],
        ),
    ):
        result = resolve_task_default_knowledge_base_ids(db, task_id=100, user_id=7)

    assert result == [11, 22]


def test_resolve_task_defaults_requires_agent_access():
    from app.services.chat.task_default_knowledge_bases import (
        resolve_task_default_knowledge_base_ids,
    )

    db = Mock()
    task = SimpleNamespace(json={"kind": "Task"})
    team = SimpleNamespace(id=42)

    with (
        patch(
            "app.services.chat.task_default_knowledge_bases.task_store.get_active_task",
            return_value=task,
        ),
        patch(
            "app.services.chat.task_default_knowledge_bases.Task.model_validate",
            return_value=SimpleNamespace(),
        ),
        patch(
            "app.services.chat.task_default_knowledge_bases.resolve_task_ref_team",
            return_value=team,
        ),
        patch(
            "app.services.chat.task_default_knowledge_bases.team_share_service.get_resource",
            return_value=None,
        ),
        patch(
            "app.services.chat.task_default_knowledge_bases._iter_team_member_default_knowledge_base_ids"
        ) as iter_defaults,
    ):
        result = resolve_task_default_knowledge_base_ids(db, task_id=100, user_id=7)

    assert result == []
    iter_defaults.assert_not_called()


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
