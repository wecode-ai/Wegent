# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for Artifact node chat source resolution."""

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from app.api.ws.chat_namespace import _apply_artifact_node_scope
from app.api.ws.events import (
    ArtifactNodeContextPayload,
    ChatSendPayload,
    ContextItem,
)
from app.services.chat.preprocessing.contexts import _prepare_contexts_for_creation


def build_payload() -> ChatSendPayload:
    return ChatSendPayload(
        team_id=9,
        message="解释这个节点",
        task_type="knowledge",
        knowledge_base_id=12,
        artifact_context=ArtifactNodeContextPayload(
            artifact_id="artifact-1",
            node_id="node-2",
        ),
        attachment_id=88,
        attachment_ids=[88, 89],
        contexts=[
            ContextItem(
                type="knowledge_base",
                data={
                    "knowledge_id": 12,
                    "document_ids": [999],
                    "scope_restricted": True,
                },
            ),
            ContextItem(
                type="selected_documents",
                data={
                    "knowledge_base_id": 12,
                    "document_ids": [999],
                },
            ),
            ContextItem(
                type="table",
                data={"document_id": 8, "name": "数据表"},
            ),
            ContextItem(
                type="knowledge_base",
                data={
                    "knowledge_id": 13,
                    "document_ids": [777],
                    "scope_restricted": True,
                },
            ),
        ],
    )


def test_artifact_node_scope_replaces_client_document_selection():
    payload = build_payload()

    with patch(
        "app.services.knowledge.artifact_service.ArtifactService.resolve_mind_map_node",
        return_value=(SimpleNamespace(id="node-2"), [101, 102]),
    ):
        _apply_artifact_node_scope(
            db=MagicMock(),
            user=SimpleNamespace(id=7),
            payload=payload,
        )

    assert [context.type for context in payload.contexts] == ["knowledge_base"]
    assert payload.attachment_id is None
    assert payload.attachment_ids is None
    resolved = payload.contexts[0].data
    assert resolved["document_ids"] == [101, 102]
    assert resolved["scope_restricted"] is True
    assert resolved["artifact_context"] == {
        "artifact_id": "artifact-1",
        "node_id": "node-2",
    }

    kb_contexts, _, _, _ = _prepare_contexts_for_creation(
        payload.contexts,
        subtask_id=21,
        user_id=7,
    )
    assert kb_contexts[0].type_data["artifact_context"] == {
        "artifact_id": "artifact-1",
        "node_id": "node-2",
    }


def test_artifact_node_scope_requires_knowledge_task():
    payload = build_payload()
    payload.task_type = "chat"

    with pytest.raises(ValueError, match="knowledge base task"):
        _apply_artifact_node_scope(
            db=MagicMock(),
            user=SimpleNamespace(id=7),
            payload=payload,
        )
