# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime
from unittest.mock import Mock, patch

from app.models.kind import Kind
from app.schemas.bot import BotCreate, BotUpdate
from app.services.adapters.bot_kinds import BotKindsService


def test_bot_create_schema_preserves_default_knowledge_base_refs():
    payload = BotCreate(
        name="kb-bot",
        shell_name="ClaudeCode",
        agent_config={"bind_model": "gpt-4.1", "bind_model_type": "public"},
        default_knowledge_base_refs=[{"id": 101, "name": "Product Docs"}],
    )

    assert payload.model_dump()["default_knowledge_base_refs"] == [
        {"id": 101, "name": "Product Docs"}
    ]


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
        with patch.object(
            service, "_get_bot_components", return_value=(ghost, None, None)
        ):
            with patch.object(
                service,
                "_convert_to_bot_dict",
                return_value={
                    "default_knowledge_base_refs": [{"id": 101, "name": "Product Docs"}]
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
