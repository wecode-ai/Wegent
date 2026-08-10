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


def _make_ghost(
    name: str,
    refs: list[dict],
    external_refs: list[dict] | None = None,
):
    ghost = Mock()
    ghost.json = {
        "kind": "Ghost",
        "apiVersion": "agent.wecode.io/v1",
        "metadata": {"name": name, "namespace": "default"},
        "spec": {
            "systemPrompt": "hello",
            "mcpServers": {},
            "defaultKnowledgeBaseRefs": refs,
            "defaultExternalKnowledgeRefs": external_refs or [],
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


def _patch_accessible_kbs(kb_map: dict[int, Mock]):
    return patch(
        "app.services.chat.knowledge_binding_resolver."
        "KnowledgeShareService.get_accessible_resources_by_ids",
        side_effect=lambda _db, resource_ids, _user_id: {
            kb_id: kb_map[kb_id] for kb_id in resource_ids if kb_id in kb_map
        },
    )


def test_build_initial_task_knowledge_base_refs_collects_only_ghost_defaults():
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

    with patch(
        "app.services.chat.knowledge_binding_resolver."
        "KnowledgeBindingResolver._iter_team_member_ghosts",
        return_value=[
            _make_ghost("ghost-one", [{"id": 11, "name": "Product Docs"}]),
            _make_ghost("ghost-two", [{"id": 22, "name": "Runbooks"}]),
        ],
    ):
        with _patch_accessible_kbs(kb_map):
            refs = build_initial_task_knowledge_base_refs(
                db=db,
                user=user,
                team=team,
            )

    assert [ref["id"] for ref in refs] == [11, 22]


def test_default_knowledge_uses_team_owner_when_execution_user_differs():
    from app.services.chat.task_default_knowledge_bases import (
        build_initial_task_knowledge_bindings,
    )

    db = Mock()
    team = _make_team()
    owner = _make_user()
    current_user = Mock()
    current_user.id = 42
    current_user.user_name = "bob"
    db.query.return_value.filter.return_value.first.return_value = owner
    kb_map = {
        11: _make_kb(11, "Owner Docs"),
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
                [{"id": 11, "name": "Owner Docs"}],
            ),
            "ghost-two": _make_ghost("ghost-two", []),
        }.get(name)

    with patch(
        "app.services.chat.knowledge_binding_resolver."
        "KnowledgeBindingResolver._iter_team_member_ghosts",
        return_value=[
            _make_ghost("ghost-one", [{"id": 11, "name": "Owner Docs"}]),
            _make_ghost("ghost-two", []),
        ],
    ):
        with _patch_accessible_kbs(kb_map) as get_kbs:
            bindings = build_initial_task_knowledge_bindings(
                db=db,
                user=current_user,
                team=team,
            )

    assert [ref["id"] for ref in bindings["knowledge_base_refs"]] == [11]
    assert get_kbs.call_args.args[2] == team.user_id


def test_build_initial_task_bindings_preserves_scoped_internal_defaults():
    from app.services.chat.task_default_knowledge_bases import (
        build_initial_task_knowledge_bindings,
    )

    db = Mock()
    team = _make_team()
    user = _make_user()
    kb_map = {
        11: _make_kb(11, "Product Docs"),
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
                [
                    {
                        "id": 11,
                        "name": "Product Docs",
                        "document_ids": [1001],
                        "document_names": ["Install Guide"],
                        "scope_restricted": True,
                    }
                ],
            ),
            "ghost-two": _make_ghost("ghost-two", []),
        }.get(name)

    with patch(
        "app.services.chat.knowledge_binding_resolver."
        "KnowledgeBindingResolver._iter_team_member_ghosts",
        return_value=[
            _make_ghost(
                "ghost-one",
                [
                    {
                        "id": 11,
                        "name": "Product Docs",
                        "document_ids": [1001],
                        "document_names": ["Install Guide"],
                        "scope_restricted": True,
                    }
                ],
            ),
            _make_ghost("ghost-two", []),
        ],
    ):
        with patch(
            "app.services.knowledge.folder_service."
            "KnowledgeFolderService.resolve_document_ids_for_scope",
            return_value=[1001],
        ):
            with _patch_accessible_kbs(kb_map):
                bindings = build_initial_task_knowledge_bindings(
                    db=db,
                    user=user,
                    team=team,
                )

    assert bindings["knowledge_base_refs"] == [
        {
            "id": 11,
            "name": "Product Docs",
            "boundBy": "alice",
            "boundAt": bindings["knowledge_base_refs"][0]["boundAt"],
            "namespace": "default",
            "scopeRestricted": True,
            "explicitDocumentIds": [1001],
            "folderIds": None,
            "includeSubfolders": True,
        }
    ]
    assert bindings["knowledge_base_scopes"] == bindings["knowledge_base_refs"]


def test_build_initial_task_knowledge_base_refs_skips_inaccessible_refs():
    from app.services.chat.task_default_knowledge_bases import (
        build_initial_task_knowledge_base_refs,
    )

    db = Mock()
    team = _make_team()
    user = _make_user()

    with patch(
        "app.services.chat.knowledge_binding_resolver."
        "KnowledgeBindingResolver._iter_team_member_ghosts",
        return_value=[
            _make_ghost("ghost-one", [{"id": 11, "name": "Product Docs"}]),
            _make_ghost("ghost-two", [{"id": 22, "name": "Secret Docs"}]),
        ],
    ):
        with _patch_accessible_kbs({11: _make_kb(11, "Product Docs")}):
            refs = build_initial_task_knowledge_base_refs(
                db=db,
                user=user,
                team=team,
            )

    assert [ref["id"] for ref in refs] == [11]


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
        "app.services.chat.storage.task_manager.build_initial_task_knowledge_bindings",
        return_value={
            "knowledge_base_refs": [
                {"id": 11, "name": "Product Docs", "boundBy": "alice"},
                {"id": 22, "name": "Runbooks", "boundBy": "alice"},
            ],
            "external_knowledge_refs": [
                {
                    "provider": "demo-source",
                    "mode": "explicit",
                    "id": "kb-1",
                    "name": "External Docs",
                }
            ],
            "context_warnings": [],
        },
    ):
        task = create_new_task(
            db=test_db,
            user=test_user,
            team=team,
            params=params,
        )

    assert [ref["id"] for ref in task.json["spec"]["knowledgeBaseRefs"]] == [11, 22]
    assert task.json["spec"]["externalKnowledgeRefs"][0]["id"] == "kb-1"


def test_build_initial_task_bindings_skips_invalid_external_default_with_warning():
    from app.services.chat.task_default_knowledge_bases import (
        build_initial_task_knowledge_bindings,
    )
    from app.services.rag.sources import ExternalRefValidationError

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
            "ghost-one": _make_ghost(
                "ghost-one",
                [],
                [
                    {
                        "provider": "demo-source",
                        "mode": "explicit",
                        "id": "kb-invalid",
                        "name": "Invalid External",
                    }
                ],
            ),
            "ghost-two": _make_ghost("ghost-two", []),
        }.get(name)

    with (
        patch(
            "app.services.chat.knowledge_binding_resolver."
            "KnowledgeBindingResolver._iter_team_member_ghosts",
            return_value=[
                _make_ghost(
                    "ghost-one",
                    [],
                    [
                        {
                            "provider": "demo-source",
                            "mode": "explicit",
                            "id": "kb-invalid",
                            "name": "Invalid External",
                        }
                    ],
                ),
                _make_ghost("ghost-two", []),
            ],
        ),
        patch(
            "app.services.chat.external_knowledge_refs.validate_external_knowledge_refs",
            side_effect=ExternalRefValidationError(
                "raw provider failure",
                reason="not_configured",
            ),
        ),
    ):
        result = build_initial_task_knowledge_bindings(db=db, user=user, team=team)

    assert result["external_knowledge_refs"] == []
    assert result["context_warnings"] == [
        {
            "type": "external_knowledge",
            "reason": "not_configured",
            "provider": "demo-source",
            "id": "kb-invalid",
            "message": (
                "External knowledge source is not configured for the current user."
            ),
            "metadata": {
                "canonicalKey": "external:demo-source:explicit:kb-invalid:knowledge_base:::"
            },
            "name": "Invalid External",
        }
    ]


def test_missing_team_owner_materializes_no_defaults_without_sender_fallback():
    from app.services.chat.task_default_knowledge_bases import (
        build_initial_task_knowledge_bindings,
    )

    db = Mock()
    db.query.return_value.filter.return_value.first.return_value = None
    team = _make_team()
    sender = Mock(id=42, user_name="member")

    def _kind_lookup(_, __, kind_type, ___, name):
        if kind_type.value == "Bot":
            return {
                "bot-one": _make_bot("bot-one", "ghost-one"),
                "bot-two": _make_bot("bot-two", "ghost-two"),
            }.get(name)
        return {
            "ghost-one": _make_ghost(
                "ghost-one",
                [{"id": 11, "name": "Owner Docs"}],
                [
                    {
                        "provider": "demo-source",
                        "mode": "explicit",
                        "id": "owner-external",
                    }
                ],
            ),
            "ghost-two": _make_ghost("ghost-two", []),
        }.get(name)

    with (
        patch(
            "app.services.chat.knowledge_binding_resolver."
            "KnowledgeBindingResolver._iter_team_member_ghosts",
            return_value=[
                _make_ghost(
                    "ghost-one",
                    [{"id": 11, "name": "Owner Docs"}],
                    [
                        {
                            "provider": "demo-source",
                            "mode": "explicit",
                            "id": "owner-external",
                        }
                    ],
                ),
                _make_ghost("ghost-two", []),
            ],
        ),
        patch(
            "app.services.chat.knowledge_binding_resolver."
            "KnowledgeShareService.get_accessible_resources_by_ids"
        ) as accessible,
    ):
        result = build_initial_task_knowledge_bindings(
            db=db,
            user=sender,
            team=team,
        )

    assert result["knowledge_base_refs"] == []
    assert result["external_knowledge_refs"] == []
    assert {warning["reason"] for warning in result["context_warnings"]} == {
        "actor_not_found"
    }
    assert len(result["context_warnings"]) == 2
    accessible.assert_not_called()
