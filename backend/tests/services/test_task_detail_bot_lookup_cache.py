# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime
from types import SimpleNamespace
from unittest.mock import Mock, patch

import pytest
from sqlalchemy.orm import Session

from app.services.adapters.task_kinds.task_detail_helpers import (
    convert_subtasks_to_dict,
    get_bots_for_subtasks,
)
from app.services.readers.kinds import KindType


def _build_bot(bot_id: int) -> SimpleNamespace:
    now = datetime.now()
    return SimpleNamespace(
        id=bot_id,
        user_id=10,
        name=f"bot-{bot_id}",
        json={"kind": "Bot"},
        is_active=True,
        created_at=now,
        updated_at=now,
    )


def _build_subtask_with_contexts(contexts: list[SimpleNamespace]) -> SimpleNamespace:
    return SimpleNamespace(
        id=100,
        task_id=200,
        team_id=300,
        title="User message",
        bot_ids=[],
        role="USER",
        prompt="Use these contexts",
        executor_namespace=None,
        executor_name=None,
        message_id=1,
        parent_id=None,
        status="COMPLETED",
        progress=100,
        result=None,
        error_message=None,
        user_id=10,
        created_at=None,
        updated_at=None,
        completed_at=None,
        contexts=contexts,
        sender_type="USER",
        sender_user_id=10,
        sender_user_name="alice",
        reply_to_subtask_id=None,
    )


@pytest.mark.unit
def test_get_bots_for_subtasks_caches_shared_model_and_shell_queries():
    db = Mock(spec=Session)
    bot_objects = [_build_bot(1), _build_bot(2)]

    bot_crd = SimpleNamespace(
        spec=SimpleNamespace(
            modelRef=SimpleNamespace(namespace="default", name="shared-model"),
            shellRef=SimpleNamespace(namespace="default", name="shared-shell"),
        )
    )
    shell_crd = SimpleNamespace(spec=SimpleNamespace(shellType="ClaudeCode"))
    model_kind = SimpleNamespace(user_id=10)
    shell_kind = SimpleNamespace(json={"kind": "Shell"})

    def _lookup_side_effect(_db, _user_id, kind, _namespace, _name):
        if kind == KindType.MODEL:
            return model_kind
        if kind == KindType.SHELL:
            return shell_kind
        return None

    with (
        patch(
            "app.services.readers.kinds.kindReader.get_by_ids", return_value=bot_objects
        ),
        patch(
            "app.services.adapters.task_kinds.task_detail_helpers.Bot.model_validate",
            return_value=bot_crd,
        ),
        patch(
            "app.services.adapters.task_kinds.task_detail_helpers.Shell.model_validate",
            return_value=shell_crd,
        ),
        patch(
            "app.services.readers.kinds.kindReader.get_by_name_and_namespace",
            side_effect=_lookup_side_effect,
        ) as mock_lookup,
    ):
        result = get_bots_for_subtasks(db, {1, 2})

    assert len(result) == 2
    assert result[1]["agent_config"]["bind_model"] == "shared-model"
    assert result[1]["shell_type"] == "ClaudeCode"
    assert result[2]["agent_config"]["bind_model"] == "shared-model"
    assert result[2]["shell_type"] == "ClaudeCode"
    assert mock_lookup.call_count == 2


@pytest.mark.unit
def test_convert_subtasks_to_dict_preserves_scoped_knowledge_context_fields():
    subtask = _build_subtask_with_contexts(
        [
            SimpleNamespace(
                id=1,
                context_type="knowledge_base",
                name="Engineering KB",
                status="ready",
                type_data={
                    "knowledge_id": 42,
                    "document_count": 8,
                    "document_ids": [101, 102],
                    "scope_restricted": True,
                },
            )
        ]
    )

    result = convert_subtasks_to_dict([subtask], bots={})

    context = result[0]["contexts"][0]
    assert context["knowledge_id"] == 42
    assert context["document_count"] == 8
    assert context["document_ids"] == [101, 102]
    assert context["scope_restricted"] is True


@pytest.mark.unit
def test_convert_subtasks_to_dict_preserves_external_knowledge_context_fields():
    subtask = _build_subtask_with_contexts(
        [
            SimpleNamespace(
                id=2,
                context_type="external_knowledge",
                name="Demo Doc",
                status="ready",
                type_data={
                    "provider": "demo-source",
                    "mode": "explicit",
                    "id": "kb-1",
                    "scope": "personal",
                    "target_type": "document",
                    "node_id": "document:doc-1",
                    "document_id": "doc-1",
                    "parent_id": "folder-1",
                },
            )
        ]
    )

    result = convert_subtasks_to_dict([subtask], bots={})

    context = result[0]["contexts"][0]
    assert context["external_provider"] == "demo-source"
    assert context["external_mode"] == "explicit"
    assert context["external_id"] == "kb-1"
    assert context["external_scope"] == "personal"
    assert context["external_target_type"] == "document"
    assert context["external_node_id"] == "document:doc-1"
    assert context["external_document_id"] == "doc-1"
    assert context["external_parent_id"] == "folder-1"
