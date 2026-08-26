# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.models.kind import Kind
from app.models.knowledge import KnowledgeDocument, KnowledgeFolder
from app.models.subtask_context import ContextStatus, ContextType
from app.services.chat.selected_knowledge import (
    build_inherited_selected_knowledge_refs,
    build_selected_knowledge_context,
)
from app.services.knowledge.task_knowledge_base_service import (
    task_knowledge_base_service,
)
from shared.models import ExecutionRequest
from shared.models.knowledge import KnowledgeBaseToolAccessMode


class _Query:
    def __init__(self, values: list[SimpleNamespace]) -> None:
        self.values = values

    def filter(self, *args: object) -> "_Query":
        return self

    def all(self) -> list[SimpleNamespace]:
        return self.values


class _KnowledgeDB:
    def query(self, model: object) -> _Query:
        if model is Kind:
            return _Query([])
        if model is KnowledgeFolder:
            return _Query([])
        if model is KnowledgeDocument:
            return _Query([SimpleNamespace(id=9, name="接口约定")])
        raise AssertionError(f"Unexpected model: {model}")

    def close(self) -> None:
        pass


def test_explicit_scope_overrides_same_task_source_and_keeps_defaults(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "app.services.chat.task_default_knowledge_bases."
        "resolve_task_default_knowledge_base_ids",
        lambda db, task_id, user_id: [13],
    )
    monkeypatch.setattr(
        task_knowledge_base_service,
        "get_knowledge_bases_by_ids",
        lambda db, knowledge_base_ids: {},
    )
    monkeypatch.setattr(
        "app.services.knowledge.knowledge_access_policy."
        "get_knowledge_base_tool_access_mode_by_ids",
        lambda db, user_id, knowledge_base_ids: (
            KnowledgeBaseToolAccessMode.FULL,
            "",
        ),
    )
    task = SimpleNamespace(
        id=1,
        json={
            "spec": {
                "knowledgeBaseRefs": [{"id": 12, "name": "任务知识"}],
            }
        },
    )
    current_contexts = [
        SimpleNamespace(
            context_type=ContextType.KNOWLEDGE_BASE.value,
            status=ContextStatus.READY.value,
            name="本轮知识",
            type_data={
                "knowledge_id": 12,
                "scope_restricted": True,
                "document_ids": [9],
            },
        )
    ]
    db = _KnowledgeDB()

    inherited_refs = build_inherited_selected_knowledge_refs(db, task, user_id=7)
    context = build_selected_knowledge_context(
        db,
        ExecutionRequest(),
        task,
        current_contexts=current_contexts,
        inherited_refs=inherited_refs,
        user_id=7,
    )

    refs = {ref.knowledge_base_id: ref for ref in context.refs}
    assert set(refs) == {"12", "13"}
    assert [resource.resource_id for resource in refs["12"].resources] == ["9"]
    assert refs["13"].resources == ()


def test_access_mode_is_resolved_against_all_effective_internal_sources(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    effective_ids: list[int] = []

    def _resolve_access_mode(db, user_id, knowledge_base_ids):
        effective_ids.extend(knowledge_base_ids)
        return KnowledgeBaseToolAccessMode.RESTRICTED_SEARCH_ONLY, "restricted"

    monkeypatch.setattr(
        "app.services.knowledge.knowledge_access_policy."
        "get_knowledge_base_tool_access_mode_by_ids",
        _resolve_access_mode,
    )
    task = SimpleNamespace(id=1, json={"spec": {}})
    inherited_refs = build_selected_knowledge_context(
        _KnowledgeDB(),
        ExecutionRequest(knowledge_base_ids=[12, 13]),
        task,
    ).refs

    context = build_selected_knowledge_context(
        _KnowledgeDB(),
        ExecutionRequest(),
        task,
        inherited_refs=inherited_refs,
        user_id=7,
    )

    assert effective_ids == [12, 13]
    assert context.refs == ()


@pytest.mark.asyncio
async def test_request_build_keeps_unselected_task_defaults(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.services.chat.trigger import unified as trigger_unified

    monkeypatch.setattr(
        "app.services.chat.task_default_knowledge_bases."
        "resolve_task_default_knowledge_base_ids",
        lambda db, task_id, user_id: [13],
    )
    monkeypatch.setattr(
        task_knowledge_base_service,
        "get_knowledge_bases_by_ids",
        lambda db, knowledge_base_ids: {},
    )
    monkeypatch.setattr(
        "app.services.knowledge.knowledge_access_policy."
        "get_knowledge_base_tool_access_mode_by_ids",
        lambda db, user_id, knowledge_base_ids: (
            KnowledgeBaseToolAccessMode.FULL,
            "",
        ),
    )
    current_contexts = [
        SimpleNamespace(
            context_type=ContextType.KNOWLEDGE_BASE.value,
            status=ContextStatus.READY.value,
            name="本轮知识",
            type_data={
                "knowledge_id": 12,
                "scope_restricted": True,
                "document_ids": [9],
            },
        )
    ]
    request = ExecutionRequest(
        task_id=1,
        subtask_id=2,
        bot=[{"shell_type": "Chat"}],
        skill_names=["wegent-knowledge"],
        skill_configs=[
            {
                "name": "wegent-knowledge",
                "mcpServers": {
                    "wegent-knowledge": {"url": "http://backend/knowledge/mcp"}
                },
            }
        ],
    )
    builder = MagicMock()
    builder.build.return_value = request
    task = SimpleNamespace(
        id=1,
        json={
            "spec": {
                "knowledgeBaseRefs": [{"id": 12, "name": "任务知识"}],
            }
        },
    )

    async def _process_contexts(db, processed_request, *args, **kwargs):
        processed_request.knowledge_base_ids = [12]
        return processed_request

    with (
        patch.object(trigger_unified, "SessionLocal", return_value=_KnowledgeDB()),
        patch(
            "app.services.execution.TaskRequestBuilder",
            return_value=builder,
        ),
        patch.object(
            trigger_unified.context_service,
            "get_by_subtask",
            return_value=current_contexts,
        ),
        patch.object(
            trigger_unified,
            "_process_contexts",
            new=AsyncMock(side_effect=_process_contexts),
        ),
    ):
        result = await trigger_unified.build_execution_request(
            task=task,
            assistant_subtask=SimpleNamespace(id=2),
            team=SimpleNamespace(id=3),
            user=SimpleNamespace(id=7, user_name="tester"),
            message="使用本轮选择",
            user_subtask_id=10,
        )

    assert 'knowledge_base_id="12"' in result.selected_knowledge_prompt
    assert 'resource_id="9"' in result.selected_knowledge_prompt
    assert 'knowledge_base_id="13"' in result.selected_knowledge_prompt
    assert result.provider_native_knowledge is True
