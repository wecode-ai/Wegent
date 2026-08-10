# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import json
import logging
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
import yaml
from fastapi import HTTPException

from app.models.knowledge import KnowledgeDocument, KnowledgeFolder
from app.services.chat.selected_knowledge import (
    PROVIDER_SKILLS,
    activate_provider_native_knowledge,
    apply_selected_knowledge_context,
    build_selected_knowledge_refs,
)
from app.services.execution.skill_mcp import extract_skill_mcp_servers
from shared.models import ExecutionRequest


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


def test_apply_selected_knowledge_context_preserves_internal_folder_and_document_scope() -> (
    None
):
    request = ExecutionRequest(knowledge_base_ids=[12, "invalid"])
    task = SimpleNamespace(
        json={
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
            }
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
    assert "folder and its descendants" in request.selected_knowledge_prompt


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


def test_provider_native_e2e_logging_records_selection_and_activation(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    monkeypatch.setenv("PROVIDER_NATIVE_E2E_LOGGING", "true")
    caplog.set_level(logging.INFO, logger="app.services.chat.selected_knowledge")
    request = ExecutionRequest(
        task_id=101,
        subtask_id=202,
        knowledge_base_ids=[12],
        bot=[{"shell_type": "Chat"}],
        skill_names=["wegent-knowledge"],
        skill_configs=[
            {
                "name": "wegent-knowledge",
                "mcpServers": {"wegent-knowledge": {"url": "https://example.com/mcp"}},
            }
        ],
    )
    task = SimpleNamespace(
        json={
            "spec": {
                "knowledgeBaseRefs": [{"id": 12, "name": "产品知识"}],
            }
        }
    )

    provider_skills = apply_selected_knowledge_context(MagicMock(), request, task)
    activate_provider_native_knowledge(request, provider_skills)

    payloads = [
        json.loads(record.getMessage().split("] ", 1)[1])
        for record in caplog.records
        if record.getMessage().startswith("[PROVIDER_NATIVE_E2E]")
    ]
    selection = next(item for item in payloads if item["event"] == "selection_built")
    activation = next(
        item for item in payloads if item["event"] == "activation_succeeded"
    )

    assert selection["task_id"] == 101
    assert selection["subtask_id"] == 202
    assert selection["refs"] == [
        {
            "provider": "wegent",
            "knowledge_base_id": "12",
            "knowledge_base_name": "产品知识",
            "resources": [],
        }
    ]
    assert len(selection["selected_prompt_sha256"]) == 64
    assert activation["provider_native_knowledge"] is True
    assert activation["expected_mcp_names"] == ["wegent-knowledge"]
