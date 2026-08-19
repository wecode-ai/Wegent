# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
import yaml
from fastapi import HTTPException

from app.models.knowledge import KnowledgeDocument, KnowledgeFolder
from app.models.subtask_context import ContextStatus, ContextType
from app.services.chat.selected_knowledge import (
    PROVIDER_SKILLS,
    activate_provider_native_knowledge,
    apply_selected_knowledge_context,
    build_selected_knowledge_refs,
    should_prepare_provider_native_knowledge,
)
from app.services.execution.skill_mcp import extract_skill_mcp_servers
from shared.models import ExecutionRequest, KnowledgeBaseScope


class _Query:
    def __init__(self, values: list[SimpleNamespace]) -> None:
        self.values = values

    def filter(self, *args: object) -> "_Query":
        return self

    def all(self) -> list[SimpleNamespace]:
        return self.values


class _KnowledgeMetadataDB:
    def query(self, model: object) -> _Query:
        if model is KnowledgeFolder:
            return _Query([SimpleNamespace(id=3, name="设计资料")])
        if model is KnowledgeDocument:
            return _Query([SimpleNamespace(id=9, name="接口约定")])
        raise AssertionError(f"Unexpected model: {model}")


def test_apply_selected_knowledge_context_deduplicates_provider_skills(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setitem(PROVIDER_SKILLS, "demo", "demo-knowledge")
    task = SimpleNamespace(
        json={
            "spec": {
                "knowledgeBaseRefs": [{"id": 12, "name": "产品知识"}],
            }
        }
    )
    request = ExecutionRequest(
        knowledge_base_ids=[12],
        external_knowledge_refs=[
            {
                "provider": "dingtalk",
                "mode": "explicit",
                "id": "workspace-1",
                "name": "项目空间",
                "target_type": "folder",
                "node_id": "folder-1",
                "target_name": "评审资料",
            },
            {
                "provider": "dingtalk",
                "mode": "explicit",
                "id": "workspace-1",
                "name": "项目空间",
                "target_type": "document",
                "document_id": "doc-1",
                "target_name": "方案",
            },
            {
                "provider": "dingtalk",
                "mode": "explicit",
                "id": "workspace-1",
                "name": "项目空间",
                "target_type": "document",
                "document_id": "doc-2",
                "target_name": "接口",
            },
            {
                "provider": "demo",
                "mode": "explicit",
                "id": "demo-1",
                "name": "示例规范",
            },
        ],
    )

    skills = apply_selected_knowledge_context(MagicMock(), request, task)
    refs = build_selected_knowledge_refs(MagicMock(), request, task)

    assert skills == ["wegent-knowledge", "dingtalk-docs", "demo-knowledge"]
    assert request.preload_skills == skills
    assert request.user_selected_skills == skills
    assert request.selected_knowledge_prompt.count("<source ") == 3
    assert request.selected_knowledge_prompt.count("<resource ") == 3
    assert 'scope_type="folder"' in request.selected_knowledge_prompt
    assert 'resource_id="folder-1"' in request.selected_knowledge_prompt
    assert 'resource_id="doc-2"' in request.selected_knowledge_prompt
    dingtalk_ref = next(ref for ref in refs if ref.provider == "dingtalk")
    assert [resource.resource_id for resource in dingtalk_ref.resources] == [
        "folder-1",
        "doc-1",
        "doc-2",
    ]
    assert request.provider_native_knowledge is False


def test_apply_selected_knowledge_context_is_idempotent(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setitem(PROVIDER_SKILLS, "demo", "demo-knowledge")
    request = ExecutionRequest(
        external_knowledge_refs=[
            {
                "provider": "demo",
                "mode": "explicit",
                "id": "demo-1",
                "name": "示例规范",
            }
        ],
        preload_skills=["demo-knowledge"],
        user_selected_skills=["demo-knowledge"],
    )
    task = SimpleNamespace(json={"spec": {}})

    apply_selected_knowledge_context(MagicMock(), request, task)
    apply_selected_knowledge_context(MagicMock(), request, task)

    assert request.preload_skills == ["demo-knowledge"]
    assert request.user_selected_skills == ["demo-knowledge"]


def test_current_external_selection_replaces_all_task_knowledge(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setitem(PROVIDER_SKILLS, "demo", "demo-knowledge")
    task = SimpleNamespace(
        json={"spec": {"knowledgeBaseRefs": [{"id": 12, "name": "默认知识"}]}}
    )
    request = ExecutionRequest(
        knowledge_base_ids=[12],
        external_knowledge_refs=[
            {
                "provider": "dingtalk",
                "mode": "explicit",
                "id": "task-space",
                "name": "Task 空间",
            },
            {
                "provider": "demo",
                "mode": "explicit",
                "id": "selected-space",
                "name": "本轮空间",
            },
        ],
    )
    current_contexts = [
        SimpleNamespace(
            context_type=ContextType.EXTERNAL_KNOWLEDGE.value,
            status=ContextStatus.READY.value,
            name="本轮空间",
            type_data={
                "provider": "demo",
                "mode": "explicit",
                "id": "selected-space",
            },
        )
    ]

    skills = apply_selected_knowledge_context(
        MagicMock(), request, task, current_contexts=current_contexts
    )

    assert skills == ["demo-knowledge"]
    assert 'provider="demo"' in request.selected_knowledge_prompt
    assert 'knowledge_base_id="selected-space"' in request.selected_knowledge_prompt
    assert 'knowledge_base_name="本轮空间"' in request.selected_knowledge_prompt
    assert 'knowledge_base_id="12"' not in request.selected_knowledge_prompt
    assert 'knowledge_base_id="task-space"' not in request.selected_knowledge_prompt
    assert "explicitly selected by the user" in request.selected_knowledge_prompt


def test_current_wegent_document_selection_replaces_all_task_refs() -> None:
    task = SimpleNamespace(
        json={"spec": {"knowledgeBaseRefs": [{"id": 12, "name": "默认知识"}]}}
    )
    request = ExecutionRequest(
        knowledge_base_ids=[12, 13],
        is_user_selected_kb=True,
        external_knowledge_refs=[
            {
                "provider": "dingtalk",
                "mode": "explicit",
                "id": "task-space",
                "name": "Task 空间",
            }
        ],
    )
    current_contexts = [
        SimpleNamespace(
            context_type=ContextType.SELECTED_DOCUMENTS.value,
            status=ContextStatus.READY.value,
            name="Selected Documents (1 files)",
            type_data={"knowledge_base_id": 13, "document_ids": [9]},
        )
    ]

    skills = apply_selected_knowledge_context(
        _KnowledgeMetadataDB(), request, task, current_contexts=current_contexts
    )

    assert skills == ["wegent-knowledge"]
    assert 'provider="wegent"' in request.selected_knowledge_prompt
    assert 'knowledge_base_id="13"' in request.selected_knowledge_prompt
    assert 'resource_id="9"' in request.selected_knowledge_prompt
    assert 'knowledge_base_id="12"' not in request.selected_knowledge_prompt
    assert 'knowledge_base_id="task-space"' not in request.selected_knowledge_prompt


def test_current_wegent_subscope_does_not_restore_task_whole_scope() -> None:
    task = SimpleNamespace(
        json={"spec": {"knowledgeBaseRefs": [{"id": 12, "name": "默认整库"}]}}
    )
    request = ExecutionRequest(knowledge_base_ids=[12], is_user_selected_kb=True)
    current_contexts = [
        SimpleNamespace(
            context_type=ContextType.KNOWLEDGE_BASE.value,
            status=ContextStatus.READY.value,
            name="本轮子范围",
            type_data={
                "knowledge_id": 12,
                "scope_restricted": True,
                "document_ids": [9],
            },
        )
    ]

    apply_selected_knowledge_context(
        _KnowledgeMetadataDB(), request, task, current_contexts=current_contexts
    )

    assert 'knowledge_base_name="本轮子范围"' in request.selected_knowledge_prompt
    assert 'scope_type="document"' in request.selected_knowledge_prompt
    assert 'resource_id="9"' in request.selected_knowledge_prompt


def test_explicit_empty_wegent_scope_keeps_legacy_path() -> None:
    task = SimpleNamespace(
        json={"spec": {"knowledgeBaseRefs": [{"id": 12, "name": "默认整库"}]}}
    )
    request = ExecutionRequest(knowledge_base_ids=[12], is_user_selected_kb=True)
    current_contexts = [
        SimpleNamespace(
            context_type=ContextType.KNOWLEDGE_BASE.value,
            status=ContextStatus.READY.value,
            name="空范围",
            type_data={
                "knowledge_id": 12,
                "scope_restricted": True,
                "document_ids": [],
            },
        )
    ]

    skills = apply_selected_knowledge_context(
        MagicMock(), request, task, current_contexts=current_contexts
    )

    assert skills == []
    assert request.selected_knowledge_prompt == ""
    assert request.provider_native_knowledge is False


def test_explicit_empty_wegent_scope_keeps_other_provider_refs(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setitem(PROVIDER_SKILLS, "demo", "demo-knowledge")
    task = SimpleNamespace(
        json={"spec": {"knowledgeBaseRefs": [{"id": 12, "name": "默认整库"}]}}
    )
    request = ExecutionRequest(knowledge_base_ids=[12], is_user_selected_kb=True)
    current_contexts = [
        SimpleNamespace(
            context_type=ContextType.KNOWLEDGE_BASE.value,
            status=ContextStatus.READY.value,
            name="空范围",
            type_data={
                "knowledge_id": 12,
                "scope_restricted": True,
                "document_ids": [],
            },
        ),
        SimpleNamespace(
            context_type=ContextType.EXTERNAL_KNOWLEDGE.value,
            status=ContextStatus.READY.value,
            name="本轮空间",
            type_data={
                "provider": "demo",
                "mode": "explicit",
                "id": "selected-space",
            },
        ),
    ]

    skills = apply_selected_knowledge_context(
        MagicMock(), request, task, current_contexts=current_contexts
    )

    assert skills == ["demo-knowledge"]
    assert 'provider="demo"' in request.selected_knowledge_prompt
    assert 'knowledge_base_id="selected-space"' in request.selected_knowledge_prompt
    assert 'provider="wegent"' not in request.selected_knowledge_prompt
    assert "explicitly selected by the user" in request.selected_knowledge_prompt


def test_empty_wegent_scope_keeps_other_valid_wegent_scope() -> None:
    contexts = [
        SimpleNamespace(
            context_type=ContextType.KNOWLEDGE_BASE.value,
            status=ContextStatus.READY.value,
            name="空范围",
            type_data={
                "knowledge_id": 12,
                "scope_restricted": True,
                "document_ids": [],
            },
        ),
        SimpleNamespace(
            context_type=ContextType.KNOWLEDGE_BASE.value,
            status=ContextStatus.READY.value,
            name="有效范围",
            type_data={
                "knowledge_id": 13,
                "scope_restricted": True,
                "document_ids": [9],
            },
        ),
    ]
    request = ExecutionRequest(knowledge_base_ids=[12, 13], is_user_selected_kb=True)

    skills = apply_selected_knowledge_context(
        _KnowledgeMetadataDB(),
        request,
        SimpleNamespace(json={"spec": {}}),
        current_contexts=contexts,
    )
    should_prepare = should_prepare_provider_native_knowledge(
        knowledge_base_ids=[12, 13],
        knowledge_base_scopes=[
            KnowledgeBaseScope(
                knowledge_base_id=12,
                scope_restricted=True,
                document_ids=[],
            ),
            KnowledgeBaseScope(
                knowledge_base_id=13,
                scope_restricted=True,
                document_ids=[9],
            ),
        ],
        access_mode="full",
        current_contexts=contexts,
        preload_selected_kb_skill=True,
        shell_type="Chat",
    )

    assert skills == ["wegent-knowledge"]
    assert 'knowledge_base_id="12"' not in request.selected_knowledge_prompt
    assert 'knowledge_base_id="13"' in request.selected_knowledge_prompt
    assert should_prepare is True


def test_current_wegent_folder_preserves_include_subfolders_false() -> None:
    request = ExecutionRequest(knowledge_base_ids=[12], is_user_selected_kb=True)
    contexts = [
        SimpleNamespace(
            context_type=ContextType.KNOWLEDGE_BASE.value,
            status=ContextStatus.READY.value,
            name="当前目录",
            type_data={
                "knowledge_id": 12,
                "scope_restricted": True,
                "folder_ids": [3],
                "include_subfolders": False,
            },
        )
    ]

    apply_selected_knowledge_context(
        _KnowledgeMetadataDB(),
        request,
        SimpleNamespace(json={"spec": {}}),
        current_contexts=contexts,
    )

    assert 'resource_id="3"' in request.selected_knowledge_prompt
    assert 'include_descendants="false"' in request.selected_knowledge_prompt


def test_build_selected_knowledge_refs_groups_resources_by_knowledge_base(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setitem(PROVIDER_SKILLS, "demo", "demo-knowledge")
    request = ExecutionRequest(
        external_knowledge_refs=[
            {
                "provider": "demo",
                "mode": "explicit",
                "id": "kb-1",
                "target_type": "document",
                "document_id": "doc-1",
            },
            {
                "provider": "demo",
                "mode": "explicit",
                "id": "kb-1",
                "target_type": "document",
                "document_id": "doc-2",
            },
            {
                "provider": "demo",
                "mode": "explicit",
                "id": "kb-2",
                "target_type": "document",
                "document_id": "doc-3",
            },
        ]
    )

    refs = build_selected_knowledge_refs(
        MagicMock(), request, SimpleNamespace(json={"spec": {}})
    )

    assert [ref.knowledge_base_id for ref in refs] == ["kb-1", "kb-2"]
    assert [resource.resource_id for resource in refs[0].resources] == [
        "doc-1",
        "doc-2",
    ]
    assert [resource.resource_id for resource in refs[1].resources] == ["doc-3"]


def test_selected_dingtalk_docs_and_ai_table_keyword_skill_can_coexist() -> None:
    request = ExecutionRequest(
        bot=[{"shell_type": "Chat"}],
        external_knowledge_refs=[
            {
                "provider": "dingtalk",
                "mode": "explicit",
                "id": "workspace-1",
                "name": "产品知识库",
            }
        ],
        preload_skills=["dingtalk-ai-table"],
        user_selected_skills=["dingtalk-ai-table"],
    )

    selected_skills = apply_selected_knowledge_context(
        MagicMock(), request, SimpleNamespace(json={"spec": {}})
    )

    assert selected_skills == ["dingtalk-docs"]
    assert request.preload_skills == ["dingtalk-ai-table", "dingtalk-docs"]
    assert request.user_selected_skills == [
        "dingtalk-ai-table",
        "dingtalk-docs",
    ]
    assert "dingtalk-wikispace" not in request.preload_skills


def test_chat_preserves_persisted_folder_and_document_scope() -> None:
    request = ExecutionRequest(
        knowledge_base_ids=[12, "invalid"],
        knowledge_base_scopes=[
            KnowledgeBaseScope(
                knowledge_base_id=12,
                scope_restricted=True,
                document_ids=[9],
            )
        ],
    )
    task = SimpleNamespace(
        json={
            "metadata": {"labels": {"taskType": "chat"}},
            "spec": {
                "knowledgeBaseScopes": [
                    {
                        "id": 12,
                        "name": "产品知识",
                        "scopeRestricted": True,
                        "folderIds": [3],
                        "includeSubfolders": False,
                        "explicitDocumentIds": [9],
                    }
                ]
            },
        }
    )

    db = _KnowledgeMetadataDB()
    apply_selected_knowledge_context(db, request, task)
    refs = build_selected_knowledge_refs(db, request, task)

    assert len(refs) == 1
    assert [resource.scope_type for resource in refs[0].resources] == [
        "folder",
        "document",
    ]
    assert [resource.resource_id for resource in refs[0].resources] == ["3", "9"]
    assert [resource.resource_name for resource in refs[0].resources] == [
        "设计资料",
        "接口约定",
    ]
    assert 'include_descendants="false"' in request.selected_knowledge_prompt
    assert "honor include_descendants exactly" in request.selected_knowledge_prompt


def test_workbench_prefers_request_scope_over_whole_task_binding() -> None:
    request = ExecutionRequest(
        knowledge_base_ids=[12],
        knowledge_base_scopes=[
            KnowledgeBaseScope(
                knowledge_base_id=12,
                scope_restricted=True,
                document_ids=[9],
            )
        ],
    )
    task = SimpleNamespace(
        json={
            "metadata": {"labels": {"taskType": "knowledge"}},
            "spec": {
                "knowledgeBaseRefs": [{"id": 12, "name": "产品知识"}],
            },
        }
    )

    refs = build_selected_knowledge_refs(_KnowledgeMetadataDB(), request, task)

    assert len(refs) == 1
    assert [resource.scope_type for resource in refs[0].resources] == ["document"]
    assert [resource.resource_id for resource in refs[0].resources] == ["9"]
    assert [resource.resource_name for resource in refs[0].resources] == ["接口约定"]


def test_workbench_request_whole_scope_replaces_persisted_scope() -> None:
    request = ExecutionRequest(
        knowledge_base_ids=[12],
        knowledge_base_scopes=[
            KnowledgeBaseScope(
                knowledge_base_id=12,
                scope_restricted=False,
            )
        ],
    )
    task = SimpleNamespace(
        json={
            "metadata": {"labels": {"taskType": "knowledge"}},
            "spec": {
                "knowledgeBaseScopes": [
                    {
                        "id": 12,
                        "name": "产品知识",
                        "scopeRestricted": True,
                        "explicitDocumentIds": [9],
                    }
                ]
            },
        }
    )

    refs = build_selected_knowledge_refs(_KnowledgeMetadataDB(), request, task)

    assert len(refs) == 1
    assert refs[0].resources == ()


@pytest.mark.parametrize("shell_type", ["Agno", "Dify", "Codex"])
def test_apply_selected_knowledge_context_keeps_legacy_path_for_unsupported_shells(
    shell_type: str,
) -> None:
    request = ExecutionRequest(
        bot=[{"shell_type": shell_type}],
        external_knowledge_refs=[
            {
                "provider": "demo",
                "mode": "explicit",
                "id": "demo-1",
                "name": "示例规范",
            }
        ],
    )

    selected_skills = apply_selected_knowledge_context(
        MagicMock(), request, SimpleNamespace(json={"spec": {}})
    )

    assert selected_skills == []
    assert request.selected_knowledge_prompt == ""
    assert request.preload_skills == []
    assert request.provider_native_knowledge is False


@pytest.mark.parametrize(
    ("skill_name", "expected_mcp_name"),
    [
        ("wegent-knowledge", "wegent-knowledge"),
        ("dingtalk-docs", "dingtalk-docs_dingtalk_docs"),
    ],
)
def test_provider_skill_frontmatter_matches_runtime_mcp_resolution(
    skill_name: str,
    expected_mcp_name: str,
) -> None:
    skill_path = (
        Path(__file__).resolve().parents[3]
        / "init_data"
        / "skills"
        / skill_name
        / "SKILL.md"
    )
    frontmatter = yaml.safe_load(
        skill_path.read_text(encoding="utf-8").split("---", 2)[1]
    )
    skill_config = {"name": skill_name, **frontmatter}

    servers = extract_skill_mcp_servers([skill_config])

    assert [server["name"] for server in servers] == [expected_mcp_name]

    request = ExecutionRequest(
        bot=[{"shell_type": "ClaudeCode", "mcp_servers": servers}],
        skill_names=[skill_name],
        skill_configs=[skill_config],
    )
    activate_provider_native_knowledge(request, [skill_name])

    assert request.provider_native_knowledge is True


def test_wegent_skill_does_not_broaden_selected_knowledge_queries() -> None:
    skill_path = (
        Path(__file__).resolve().parents[3]
        / "init_data"
        / "skills"
        / "wegent-knowledge"
        / "SKILL.md"
    )
    skill = skill_path.read_text(encoding="utf-8")

    assert "First, list available knowledge bases" not in skill
    assert 'use `scope="all"` directly' not in skill
    assert "Never broaden the request to the whole knowledge base" in skill


def test_dingtalk_skill_only_describes_provider_adapter_behavior() -> None:
    skill_path = (
        Path(__file__).resolve().parents[3]
        / "init_data"
        / "skills"
        / "dingtalk-docs"
        / "SKILL.md"
    )
    skill = skill_path.read_text(encoding="utf-8")

    assert "does not guarantee workspace or folder scoping" in skill
    assert "only when the user explicitly requests a mutation" not in skill
    assert "DingTalk is the authority for the current user's permissions" in skill


def test_activate_provider_native_knowledge_requires_skill_mcp() -> None:
    request = ExecutionRequest(
        bot=[{"shell_type": "Chat"}],
        skill_names=["demo-knowledge"],
        skill_configs=[{"name": "demo-knowledge"}],
    )

    with pytest.raises(HTTPException) as exc_info:
        activate_provider_native_knowledge(request, ["demo-knowledge"])

    assert exc_info.value.status_code == 503
    assert "no enabled MCP URL" in exc_info.value.detail
    assert request.provider_native_knowledge is False


@pytest.mark.parametrize("shell_type", ["Chat", "ClaudeCode"])
def test_activate_provider_native_knowledge_allows_user_config_guidance(
    shell_type: str,
) -> None:
    request = ExecutionRequest(
        bot=[{"shell_type": shell_type, "mcp_servers": []}],
        skill_names=["dingtalk-docs"],
        skill_configs=[
            {
                "name": "dingtalk-docs",
                "prompt": "Configuration Required",
            }
        ],
    )

    activate_provider_native_knowledge(request, ["dingtalk-docs"])

    assert request.provider_native_knowledge is True


@pytest.mark.parametrize(
    ("skill_name", "server_name"),
    [
        ("wegent-knowledge", "wegent-knowledge"),
        ("demo-knowledge", "demo-knowledge"),
        ("dingtalk-docs", "docs"),
    ],
)
def test_activate_provider_native_knowledge_enables_chat_after_validation(
    skill_name: str,
    server_name: str,
) -> None:
    request = ExecutionRequest(
        bot=[{"shell_type": "Chat"}],
        skill_names=[skill_name],
        skill_configs=[
            {
                "name": skill_name,
                "mcpServers": {server_name: {"url": "https://example.com/mcp"}},
            }
        ],
    )

    activate_provider_native_knowledge(request, [skill_name])

    assert request.provider_native_knowledge is True


def test_activate_provider_native_knowledge_requires_claude_mcp_mount() -> None:
    request = ExecutionRequest(
        bot=[{"shell_type": "ClaudeCode", "mcp_servers": []}],
        skill_names=["dingtalk-docs"],
        skill_configs=[
            {
                "name": "dingtalk-docs",
                "mcpServers": {
                    "dingtalk-docs": {"url": "https://example.com/dingtalk/mcp"}
                },
            }
        ],
    )

    with pytest.raises(HTTPException) as exc_info:
        activate_provider_native_knowledge(request, ["dingtalk-docs"])

    assert exc_info.value.status_code == 503
    assert "unavailable to ClaudeCode" in exc_info.value.detail
    assert request.provider_native_knowledge is False


def test_activate_provider_native_knowledge_enables_claude_after_mount() -> None:
    request = ExecutionRequest(
        bot=[
            {
                "shell_type": "ClaudeCode",
                "mcp_servers": [
                    {
                        "name": "dingtalk-docs_docs",
                        "url": "https://example.com/dingtalk/mcp",
                    }
                ],
            }
        ],
        skill_names=["dingtalk-docs"],
        skill_configs=[
            {
                "name": "dingtalk-docs",
                "mcpServers": {"docs": {"url": "https://example.com/dingtalk/mcp"}},
            }
        ],
    )

    activate_provider_native_knowledge(request, ["dingtalk-docs"])

    assert request.provider_native_knowledge is True


def test_apply_selected_knowledge_context_without_selection_keeps_native_off() -> None:
    request = ExecutionRequest(
        bot=[{"shell_type": "Chat"}],
        preload_skills=["dingtalk-docs"],
    )

    selected_skills = apply_selected_knowledge_context(
        MagicMock(), request, SimpleNamespace(json={"spec": {}})
    )

    assert selected_skills == []
    assert request.preload_skills == ["dingtalk-docs"]
    assert request.provider_native_knowledge is False
