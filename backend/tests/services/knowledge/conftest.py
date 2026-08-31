# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Shared fixtures and builders for external document import service tests."""

from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
from sqlalchemy.orm import Session

import app.tasks.knowledge_tasks as knowledge_tasks_module
from app.models.dingtalk_doc import DingtalkSyncedNode
from app.schemas.knowledge import KnowledgeBaseCreate
from app.services.knowledge.knowledge_service import KnowledgeService


def create_external_import_kb(
    test_db: Session,
    user_id: int,
    name: str = "external-import-kb",
) -> int:
    return KnowledgeService.create_knowledge_base(
        test_db,
        user_id,
        KnowledgeBaseCreate(name=name),
    )


def create_synced_node(
    test_db: Session,
    user_id: int,
    dingtalk_node_id: str,
    name: str = "DingTalk Doc",
    node_type: str = "doc",
    is_active: bool = True,
) -> DingtalkSyncedNode:
    node = DingtalkSyncedNode(
        user_id=user_id,
        dingtalk_node_id=dingtalk_node_id,
        name=name,
        doc_url=f"https://alidocs.dingtalk.com/i/nodes/{dingtalk_node_id}",
        parent_node_id="",
        node_type=node_type,
        content_type="ALIDOC" if node_type == "doc" else "",
        raw_metadata={"extension": "adoc" if node_type == "doc" else ""},
        workspace_id="",
        is_active=is_active,
        last_synced_at=datetime.now(timezone.utc),
    )
    test_db.add(node)
    test_db.commit()
    test_db.refresh(node)
    return node


@pytest.fixture
def configured_dingtalk(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "app.services.dingtalk_doc_service.DingTalkDocService.is_configured",
        lambda user: True,
    )


@pytest.fixture
def dispatched(monkeypatch: pytest.MonkeyPatch) -> list[int]:
    """Capture background import task dispatches instead of hitting Celery."""
    document_ids: list[int] = []
    monkeypatch.setattr(
        knowledge_tasks_module,
        "import_external_document_task",
        SimpleNamespace(
            delay=lambda **kwargs: document_ids.append(kwargs["document_id"])
        ),
    )
    return document_ids


@pytest.fixture
def dispatch_calls(monkeypatch: pytest.MonkeyPatch) -> list[dict]:
    """Capture background import task dispatch kwargs."""
    calls: list[dict] = []
    monkeypatch.setattr(
        knowledge_tasks_module,
        "import_external_document_task",
        SimpleNamespace(delay=lambda **kwargs: calls.append(kwargs)),
    )
    return calls
