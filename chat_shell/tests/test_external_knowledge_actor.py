# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest

from chat_shell.tools.builtin.knowledge_base import KnowledgeBaseTool
from chat_shell.tools.builtin.knowledge_listing import KnowledgeListDocumentsTool


def test_external_retrieval_uses_explicit_actor_not_sender() -> None:
    tool = KnowledgeBaseTool(
        external_knowledge_refs=[
            {"provider": "demo-source", "mode": "explicit", "id": "kb-1"}
        ],
        user_id=42,
        user_name="sender",
        external_knowledge_actor_user_id=7,
        external_knowledge_actor_user_name="owner",
    )

    assert tool._retrieval_actor_user_id() == 7
    assert tool._retrieval_actor_user_name() == "owner"


def test_external_retrieval_has_no_sender_identity_fallback() -> None:
    tool = KnowledgeBaseTool(
        external_knowledge_refs=[
            {"provider": "demo-source", "mode": "explicit", "id": "kb-1"}
        ],
        user_id=42,
        user_name="sender",
    )

    with pytest.raises(ValueError, match="external_knowledge_actor_user_id"):
        tool._retrieval_actor_user_id()


def test_external_listing_has_no_sender_identity_fallback() -> None:
    tool = KnowledgeListDocumentsTool(
        external_knowledge_refs=[
            {"provider": "demo-source", "mode": "explicit", "id": "kb-1"}
        ],
        user_id=42,
        user_name="sender",
    )

    with pytest.raises(ValueError, match="external_knowledge_actor_user_id"):
        tool._external_actor_user_id()
