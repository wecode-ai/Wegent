# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Notebook visibility through the real chat preprocessing entry."""

import json

import pytest
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.knowledge import KnowledgeDocument
from app.models.subtask_context import SubtaskContext
from app.models.user import User
from app.services.chat.preprocessing.contexts import prepare_contexts_for_chat
from shared.models.knowledge import ChatContextsResult


@pytest.fixture
def notebook_kb(test_db: Session, test_user: User) -> Kind:
    kb = Kind(
        user_id=test_user.id,
        kind="KnowledgeBase",
        name="notebook-visibility",
        namespace="default",
        json={"spec": {}},
        is_active=True,
    )
    test_db.add(kb)
    test_db.flush()
    for document_id, status, active in (
        (101, "enabled", True),
        (102, "disabled", True),
        (103, "enabled", False),
    ):
        test_db.add(
            SubtaskContext(
                id=document_id + 400,
                user_id=test_user.id,
                context_type="attachment",
                name=f"doc-{document_id}",
                extracted_text=f"BODY-{document_id}-MARKER",
                text_length=15,
            )
        )
        test_db.add(
            KnowledgeDocument(
                id=document_id,
                kind_id=kb.id,
                attachment_id=document_id + 400,
                name=f"doc-{document_id}",
                file_extension="md",
                user_id=test_user.id,
                status=status,
                is_active=active,
            )
        )
    test_db.flush()
    return kb


async def preprocess(
    db: Session,
    user: User,
    kb: Kind,
    document_ids: list[int],
    *,
    context_window: int = 128000,
) -> ChatContextsResult:
    selection = SubtaskContext(
        user_id=user.id,
        context_type="selected_documents",
        status="ready",
        name="selection",
        type_data={"knowledge_base_id": kb.id, "document_ids": document_ids},
    )
    return await prepare_contexts_for_chat(
        db=db,
        user_subtask_id=1,
        user_id=user.id,
        message="question",
        base_system_prompt="system",
        contexts=[selection],
        context_window=context_window,
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("context_window", [16, 128000])
async def test_notebook_injects_only_enabled_active_documents(
    test_db: Session, test_user: User, notebook_kb: Kind, context_window: int
) -> None:
    result = await preprocess(
        test_db, test_user, notebook_kb, [101, 102, 103], context_window=context_window
    )
    content = json.dumps(result.final_message)
    assert "BODY-101-MARKER" in content
    assert "BODY-102-MARKER" not in content
    assert "BODY-103-MARKER" not in content
    assert result.kb.extra_tools == []


@pytest.mark.asyncio
async def test_notebook_empty_effective_scope_does_not_create_rag_tool(
    test_db: Session, test_user: User, notebook_kb: Kind
) -> None:
    result = await preprocess(
        test_db, test_user, notebook_kb, [102, 103], context_window=1
    )
    assert result.final_message == "question"
    assert result.kb.enhanced_system_prompt == "system"
    assert result.kb.extra_tools == []


@pytest.mark.asyncio
async def test_notebook_reenable_restores_body_without_expanding_selection(
    test_db: Session, test_user: User, notebook_kb: Kind
) -> None:
    for status in ("disabled", "enabled", "disabled"):
        test_db.get(KnowledgeDocument, 102).status = status
        test_db.flush()
        result = await preprocess(test_db, test_user, notebook_kb, [102])
        content = json.dumps(result.final_message)
        assert ("BODY-102-MARKER" in content) is (status == "enabled")
        assert "BODY-101-MARKER" not in content
        assert result.kb.extra_tools == []


@pytest.mark.asyncio
async def test_notebook_rag_uses_only_effective_document_ids(
    test_db: Session, test_user: User, notebook_kb: Kind
) -> None:
    result = await preprocess(
        test_db, test_user, notebook_kb, [101, 102, 103], context_window=1
    )
    assert result.final_message == "question"
    assert len(result.kb.extra_tools) == 1
    assert result.kb.extra_tools[0].document_ids == [101]
    assert result.kb.extra_tools[0].knowledge_base_ids == [notebook_kb.id]
