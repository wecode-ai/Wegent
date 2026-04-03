# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

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


def test_build_initial_task_knowledge_base_refs_collects_defaults_and_merges_explicit():
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

    assert [ref["id"] for ref in refs] == [11, 22, 33]


def test_build_initial_task_knowledge_base_refs_deduplicates_by_id():
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

    assert [ref["id"] for ref in refs] == [11, 22]


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

    assert [ref["id"] for ref in refs] == [11]


def test_create_new_task_writes_initial_knowledge_base_refs_for_chat_tasks():
    db = Mock()
    user = _make_user()
    team = _make_team()

    placeholder_query = Mock()
    placeholder_query.filter.return_value = placeholder_query
    placeholder_query.first.return_value = None
    db.query.return_value = placeholder_query

    params = TaskCreationParams(
        message="hello",
        task_type="chat",
    )

    with patch(
        "app.services.adapters.task_kinds.task_kinds_service.create_task_id",
        return_value=123,
    ):
        with patch(
            "app.services.adapters.task_kinds.task_kinds_service.validate_task_id",
            return_value=True,
        ):
            with patch(
                "app.services.chat.storage.task_manager.build_initial_task_knowledge_base_refs",
                return_value=[
                    {"id": 11, "name": "Product Docs", "boundBy": "alice"},
                    {"id": 22, "name": "Runbooks", "boundBy": "alice"},
                ],
            ):
                task = create_new_task(
                    db=db,
                    user=user,
                    team=team,
                    params=params,
                )

    assert [ref["id"] for ref in task.json["spec"]["knowledgeBaseRefs"]] == [11, 22]
