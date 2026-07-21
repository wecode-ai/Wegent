# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime
from types import SimpleNamespace
from unittest.mock import Mock, patch

import pytest
from fastapi import HTTPException

from app.models.kind import Kind
from app.schemas.bot import BotCreate, BotUpdate
from app.services.adapters.bot_kinds import BotKindsService
from app.services.rag.sources import ExternalRefValidationError


@pytest.fixture(autouse=True)
def allow_direct_knowledge_base_access():
    with patch(
        "app.services.adapters.bot_kinds.KnowledgeService.can_directly_access_knowledge_base",
        return_value=True,
    ):
        yield


def test_bot_create_schema_preserves_default_knowledge_base_refs():
    payload = BotCreate(
        name="kb-bot",
        shell_name="ClaudeCode",
        agent_config={"bind_model": "gpt-4.1", "bind_model_type": "public"},
        default_knowledge_base_refs=[
            {
                "id": 101,
                "name": "Product Docs",
                "document_ids": [1001],
                "document_names": ["Install Guide"],
                "scope_restricted": True,
            }
        ],
    )

    assert payload.model_dump(exclude_none=True)["default_knowledge_base_refs"] == [
        {
            "id": 101,
            "name": "Product Docs",
            "document_ids": [1001],
            "document_names": ["Install Guide"],
            "include_subfolders": True,
            "scope_restricted": True,
        }
    ]


def test_bot_create_schema_preserves_default_external_knowledge_refs():
    payload = BotCreate(
        name="external-bot",
        shell_name="ClaudeCode",
        agent_config={"bind_model": "gpt-4.1", "bind_model_type": "public"},
        default_external_knowledge_refs=[
            {
                "provider": "demo-source",
                "mode": "explicit",
                "id": "kb-1",
                "name": "External Docs",
            }
        ],
    )

    assert payload.model_dump(exclude_none=True)["default_external_knowledge_refs"] == [
        {
            "provider": "demo-source",
            "mode": "explicit",
            "id": "kb-1",
            "name": "External Docs",
        }
    ]


def test_default_knowledge_base_binding_requires_direct_access():
    service = BotKindsService(Kind)

    with patch(
        "app.services.adapters.bot_kinds.KnowledgeService.can_directly_access_knowledge_base",
        return_value=False,
    ):
        with pytest.raises(HTTPException, match="not directly accessible"):
            service._validate_default_knowledge_bases(
                Mock(),
                [SimpleNamespace(id=101, name="Hidden Docs")],
                user_id=7,
                namespace="default",
            )


def test_create_with_user_writes_default_knowledge_bases_into_ghost_spec():
    service = BotKindsService(Kind)
    db = Mock()
    added_objects = []
    db.add.side_effect = added_objects.append
    duplicate_check_query = Mock()
    duplicate_check_query.filter.return_value = duplicate_check_query
    duplicate_check_query.first.return_value = None
    db.query.return_value = duplicate_check_query

    with patch.object(service, "_encrypt_agent_config", return_value={}):
        with patch.object(service, "_validate_default_knowledge_bases"):
            with patch(
                "app.services.adapters.bot_kinds.get_shell_info_by_name",
                return_value={
                    "shell_type": "ClaudeCode",
                    "execution_type": "local_engine",
                    "base_image": "python:3.11",
                    "is_custom": False,
                    "namespace": "default",
                },
            ):
                with patch(
                    "app.services.adapters.bot_kinds.get_shell_by_name",
                    return_value=None,
                ):
                    with patch.object(service, "_get_model_by_name", return_value=None):
                        with patch.object(
                            service,
                            "_convert_to_bot_dict",
                            return_value={"id": 1},
                        ):
                            service.create_with_user(
                                db,
                                obj_in=BotCreate(
                                    name="kb-bot",
                                    shell_name="ClaudeCode",
                                    agent_config={},
                                    default_knowledge_base_refs=[
                                        {"id": 101, "name": "Product Docs"}
                                    ],
                                ),
                                user_id=7,
                            )

    ghost = next(
        obj for obj in added_objects if isinstance(obj, Kind) and obj.kind == "Ghost"
    )
    assert ghost.json["spec"]["defaultKnowledgeBaseRefs"] == [
        {"id": 101, "name": "Product Docs"}
    ]


def test_create_with_user_writes_default_external_knowledge_refs_into_ghost_spec():
    service = BotKindsService(Kind)
    db = Mock()
    added_objects = []
    db.add.side_effect = added_objects.append
    duplicate_check_query = Mock()
    duplicate_check_query.filter.return_value = duplicate_check_query
    duplicate_check_query.first.return_value = None
    db.query.return_value = duplicate_check_query

    with patch.object(service, "_encrypt_agent_config", return_value={}):
        with patch(
            "app.services.adapters.bot_kinds.validate_external_refs"
        ) as validate_refs:
            with patch(
                "app.services.adapters.bot_kinds.get_shell_info_by_name",
                return_value={
                    "shell_type": "ClaudeCode",
                    "execution_type": "local_engine",
                    "base_image": "python:3.11",
                    "is_custom": False,
                    "namespace": "default",
                },
            ):
                with patch(
                    "app.services.adapters.bot_kinds.get_shell_by_name",
                    return_value=None,
                ):
                    with patch.object(service, "_get_model_by_name", return_value=None):
                        with patch.object(
                            service,
                            "_convert_to_bot_dict",
                            return_value={"id": 1},
                        ):
                            service.create_with_user(
                                db,
                                obj_in=BotCreate(
                                    name="external-bot",
                                    shell_name="ClaudeCode",
                                    agent_config={},
                                    default_external_knowledge_refs=[
                                        {
                                            "provider": "demo-source",
                                            "mode": "explicit",
                                            "id": "kb-1",
                                            "name": "External Docs",
                                        }
                                    ],
                                ),
                                user_id=7,
                            )

    validate_refs.assert_called_once()
    ghost = next(
        obj for obj in added_objects if isinstance(obj, Kind) and obj.kind == "Ghost"
    )
    assert ghost.json["spec"]["defaultExternalKnowledgeRefs"] == [
        {
            "provider": "demo-source",
            "mode": "explicit",
            "id": "kb-1",
            "name": "External Docs",
        }
    ]


def test_update_with_user_writes_default_knowledge_bases_into_ghost_spec():
    service = BotKindsService(Kind)
    db = Mock()

    bot = Mock(spec=Kind)
    bot.id = 17
    bot.user_id = 7
    bot.name = "kb-bot"
    bot.namespace = "default"
    bot.kind = "Bot"
    bot.is_active = True
    bot.created_at = datetime.now()
    bot.updated_at = datetime.now()
    bot.json = {
        "kind": "Bot",
        "apiVersion": "agent.wecode.io/v1",
        "metadata": {"name": "kb-bot", "namespace": "default"},
        "spec": {
            "ghostRef": {"name": "kb-bot-ghost", "namespace": "default"},
            "shellRef": {"name": "ClaudeCode", "namespace": "default"},
            "modelRef": {"name": "kb-bot-model", "namespace": "default"},
        },
        "status": {"state": "Available"},
    }

    ghost = Mock(spec=Kind)
    ghost.kind = "Ghost"
    ghost.name = "kb-bot-ghost"
    ghost.namespace = "default"
    ghost.updated_at = datetime.now()
    ghost.json = {
        "kind": "Ghost",
        "apiVersion": "agent.wecode.io/v1",
        "metadata": {"name": "kb-bot-ghost", "namespace": "default"},
        "spec": {
            "systemPrompt": "hello",
            "mcpServers": {},
        },
        "status": {"state": "Available"},
    }

    query = Mock()
    query.filter.return_value = query
    query.first.return_value = bot
    db.query.return_value = query

    with patch("app.services.adapters.bot_kinds.flag_modified"):
        with patch.object(service, "_validate_default_knowledge_bases"):
            with patch.object(
                service, "_get_bot_components", return_value=(ghost, None, None)
            ):
                with patch.object(
                    service,
                    "_convert_to_bot_dict",
                    return_value={
                        "default_knowledge_base_refs": [
                            {"id": 101, "name": "Product Docs"}
                        ]
                    },
                ):
                    service.update_with_user(
                        db,
                        bot_id=17,
                        obj_in=BotUpdate(
                            default_knowledge_base_refs=[
                                {"id": 101, "name": "Product Docs"}
                            ]
                        ),
                        user_id=7,
                    )

    assert ghost.json["spec"]["defaultKnowledgeBaseRefs"] == [
        {"id": 101, "name": "Product Docs"}
    ]


def test_update_with_user_writes_default_external_knowledge_refs_into_ghost_spec():
    service = BotKindsService(Kind)
    db = Mock()

    bot = Mock(spec=Kind)
    bot.id = 17
    bot.user_id = 7
    bot.name = "external-bot"
    bot.namespace = "default"
    bot.kind = "Bot"
    bot.is_active = True
    bot.created_at = datetime.now()
    bot.updated_at = datetime.now()
    bot.json = {
        "kind": "Bot",
        "apiVersion": "agent.wecode.io/v1",
        "metadata": {"name": "external-bot", "namespace": "default"},
        "spec": {
            "ghostRef": {"name": "external-bot-ghost", "namespace": "default"},
            "shellRef": {"name": "ClaudeCode", "namespace": "default"},
            "modelRef": {"name": "external-bot-model", "namespace": "default"},
        },
        "status": {"state": "Available"},
    }

    ghost = Mock(spec=Kind)
    ghost.kind = "Ghost"
    ghost.name = "external-bot-ghost"
    ghost.namespace = "default"
    ghost.updated_at = datetime.now()
    ghost.json = {
        "kind": "Ghost",
        "apiVersion": "agent.wecode.io/v1",
        "metadata": {"name": "external-bot-ghost", "namespace": "default"},
        "spec": {
            "systemPrompt": "hello",
            "mcpServers": {},
        },
        "status": {"state": "Available"},
    }

    query = Mock()
    query.filter.return_value = query
    query.first.return_value = bot
    db.query.return_value = query

    external_refs = [
        {
            "provider": "demo-source",
            "mode": "explicit",
            "id": "kb-1",
            "name": "External Docs",
        }
    ]
    with patch("app.services.adapters.bot_kinds.flag_modified"):
        with patch(
            "app.services.adapters.bot_kinds.validate_external_refs"
        ) as validate_refs:
            with patch.object(
                service, "_get_bot_components", return_value=(ghost, None, None)
            ):
                with patch.object(
                    service,
                    "_convert_to_bot_dict",
                    return_value={"default_external_knowledge_refs": external_refs},
                ):
                    service.update_with_user(
                        db,
                        bot_id=17,
                        obj_in=BotUpdate(default_external_knowledge_refs=external_refs),
                        user_id=7,
                    )

    validate_refs.assert_called_once()
    assert ghost.json["spec"]["defaultExternalKnowledgeRefs"] == external_refs


def test_convert_to_bot_dict_exposes_default_knowledge_base_refs():
    service = BotKindsService(Kind)

    bot = Mock(spec=Kind)
    bot.id = 7
    bot.user_id = 3
    bot.name = "kb-bot"
    bot.namespace = "default"
    bot.is_active = True
    bot.created_at = datetime.now()
    bot.updated_at = datetime.now()
    bot.json = {
        "kind": "Bot",
        "apiVersion": "agent.wecode.io/v1",
        "metadata": {"name": "kb-bot", "namespace": "default"},
        "spec": {
            "ghostRef": {"name": "kb-bot-ghost", "namespace": "default"},
            "shellRef": {"name": "ClaudeCode", "namespace": "default"},
            "modelRef": {"name": "shared-model", "namespace": "default"},
        },
        "status": {"state": "Available"},
    }

    ghost = Mock(spec=Kind)
    ghost.json = {
        "kind": "Ghost",
        "apiVersion": "agent.wecode.io/v1",
        "metadata": {"name": "kb-bot-ghost", "namespace": "default"},
        "spec": {
            "systemPrompt": "hello",
            "mcpServers": {},
            "defaultKnowledgeBaseRefs": [{"id": 101, "name": "Product Docs"}],
        },
        "status": {"state": "Available"},
    }

    result = service._convert_to_bot_dict(bot, ghost, None, None)

    assert result["default_knowledge_base_refs"] == [
        {"id": 101, "name": "Product Docs"}
    ]


def test_convert_to_bot_dict_exposes_default_external_knowledge_refs():
    service = BotKindsService(Kind)

    bot = Mock(spec=Kind)
    bot.id = 7
    bot.user_id = 3
    bot.name = "external-bot"
    bot.namespace = "default"
    bot.is_active = True
    bot.created_at = datetime.now()
    bot.updated_at = datetime.now()
    bot.json = {
        "kind": "Bot",
        "apiVersion": "agent.wecode.io/v1",
        "metadata": {"name": "external-bot", "namespace": "default"},
        "spec": {
            "ghostRef": {"name": "external-bot-ghost", "namespace": "default"},
            "shellRef": {"name": "ClaudeCode", "namespace": "default"},
            "modelRef": {"name": "shared-model", "namespace": "default"},
        },
        "status": {"state": "Available"},
    }

    ghost = Mock(spec=Kind)
    ghost.json = {
        "kind": "Ghost",
        "apiVersion": "agent.wecode.io/v1",
        "metadata": {"name": "external-bot-ghost", "namespace": "default"},
        "spec": {
            "systemPrompt": "hello",
            "mcpServers": {},
            "defaultExternalKnowledgeRefs": [
                {
                    "provider": "demo-source",
                    "mode": "explicit",
                    "id": "kb-1",
                    "name": "External Docs",
                }
            ],
        },
        "status": {"state": "Available"},
    }

    result = service._convert_to_bot_dict(bot, ghost, None, None)

    assert result["default_external_knowledge_refs"] == [
        {
            "provider": "demo-source",
            "mode": "explicit",
            "id": "kb-1",
            "name": "External Docs",
        }
    ]


def test_create_with_user_rejects_invalid_default_external_knowledge_refs():
    service = BotKindsService(Kind)

    with patch(
        "app.services.adapters.bot_kinds.validate_external_refs",
        side_effect=ExternalRefValidationError("invalid external provider"),
    ):
        try:
            service._validate_default_external_knowledge_refs(
                [
                    {
                        "provider": "demo-source",
                        "mode": "explicit",
                        "id": "kb-1",
                    }
                ],
                user_id=7,
            )
        except HTTPException as exc:
            assert exc.status_code == 400
        else:
            raise AssertionError("Expected HTTPException")


def test_group_bot_accepts_any_owner_accessible_knowledge_source():
    service = BotKindsService(Kind)
    db = Mock()

    with patch(
        "app.services.adapters.bot_kinds.KnowledgeBindingResolver.filter_internal_bindings",
        return_value=([{"id": 101}], []),
    ) as filter_bindings:
        service._validate_default_knowledge_bases(
            db,
            [SimpleNamespace(id=101, name="Personal Docs")],
            user_id=7,
        )

    filter_bindings.assert_called_once_with(
        refs=[{"id": 101}],
        actor_user_id=7,
    )


def test_bot_rejects_knowledge_source_inaccessible_to_owner():
    service = BotKindsService(Kind)
    db = Mock()

    with patch(
        "app.services.adapters.bot_kinds.KnowledgeBindingResolver.filter_internal_bindings",
        return_value=(
            [],
            [{"type": "knowledge_base", "reason": "access_denied", "id": "101"}],
        ),
    ):
        try:
            service._validate_default_knowledge_bases(
                db,
                [SimpleNamespace(id=101, name="Private Docs")],
                user_id=7,
            )
        except HTTPException as exc:
            assert exc.status_code == 400
            assert (
                exc.detail == "One or more default knowledge bases are not accessible"
            )
        else:
            raise AssertionError("Expected HTTPException")


def test_clone_bot_revalidates_defaults_as_new_owner():
    service = BotKindsService(Kind)
    db = Mock()
    original = Mock(spec=Kind)
    original.user_id = 7
    query = Mock()
    query.filter.return_value = query
    query.first.return_value = original
    db.query.return_value = query
    bot_dict = {
        "shell_name": "ClaudeCode",
        "agent_config": {},
        "default_knowledge_base_refs": [{"id": 101, "name": "Owner docs"}],
        "default_external_knowledge_refs": [
            {
                "provider": "demo-source",
                "mode": "explicit",
                "id": "owner-external",
            }
        ],
    }

    with (
        patch.object(service, "_get_bot_components", return_value=(None, None, None)),
        patch.object(service, "_convert_to_bot_dict", return_value=bot_dict),
        patch.object(service, "create_with_user", return_value={"id": 22}) as create,
    ):
        result = service.clone_bot(
            db,
            bot_id=1,
            user_id=99,
            new_name="Copied agent",
        )

    assert result == {"id": 22}
    assert create.call_args.kwargs["user_id"] == 99
    assert create.call_args.kwargs["filter_inaccessible_defaults"] is True


def test_copy_filter_drops_defaults_inaccessible_to_new_owner():
    service = BotKindsService(Kind)
    payload = BotCreate(
        name="Copied agent",
        shell_name="ClaudeCode",
        agent_config={},
        default_knowledge_base_refs=[{"id": 101, "name": "Old owner docs"}],
        default_external_knowledge_refs=[
            {
                "provider": "ap",
                "mode": "explicit",
                "id": "old-owner-ap",
            }
        ],
    )
    internal_warning = {"type": "knowledge_base", "id": "101"}
    external_warning = {
        "type": "external_knowledge",
        "provider": "ap",
        "id": "old-owner-ap",
    }

    with (
        patch(
            "app.services.adapters.bot_kinds."
            "KnowledgeBindingResolver.filter_internal_bindings",
            return_value=([], [internal_warning]),
        ) as filter_internal,
        patch(
            "app.services.adapters.bot_kinds.filter_valid_external_knowledge_refs",
            return_value=([], [external_warning]),
        ) as filter_external,
    ):
        filtered, warnings = service._filter_defaults_for_owner(
            Mock(),
            payload,
            user_id=99,
        )

    assert filtered.default_knowledge_base_refs == []
    assert filtered.default_external_knowledge_refs == []
    assert warnings == [internal_warning, external_warning]
    assert filter_internal.call_args.kwargs["actor_user_id"] == 99
    assert filter_external.call_args.kwargs["actor_user_id"] == 99
