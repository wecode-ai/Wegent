# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from shared.models.knowledge import SelectedKnowledgeRef, SelectedKnowledgeResource
from shared.prompts import render_selected_knowledge_prompt


def test_render_selected_knowledge_prompt_preserves_provider_scopes() -> None:
    prompt = render_selected_knowledge_prompt(
        [
            SelectedKnowledgeRef(
                provider="wegent",
                knowledge_base_id="12",
                knowledge_base_name="产品知识",
                retrieval_capabilities={
                    "retrieval_mode": "hybrid",
                    "semantic_query": True,
                    "keywords": True,
                    "phrases": True,
                },
            ),
            SelectedKnowledgeRef(
                provider="dingtalk",
                knowledge_base_id="workspace-1",
                knowledge_base_name="团队空间",
                resources=(
                    SelectedKnowledgeResource(
                        scope_type="folder",
                        resource_id="folder-1",
                        resource_name="评审资料",
                    ),
                ),
            ),
            SelectedKnowledgeRef(
                provider="demo",
                knowledge_base_id="ap-1",
                knowledge_base_name="AP & Docs",
                resources=(
                    SelectedKnowledgeResource(
                        scope_type="document",
                        resource_id="doc-1",
                        resource_name='A < B "说明"',
                        resource_url="https://example.test/doc?id=1&view=full",
                    ),
                ),
            ),
        ]
    )

    assert prompt.count("<source ") == 3
    assert prompt.count("<resource ") == 2
    assert 'provider="wegent"' in prompt
    assert 'retrieval_mode="hybrid"' in prompt
    assert 'search_hints="semantic_query,keywords,phrases"' in prompt
    assert 'scope_type="folder"' in prompt
    assert 'resource_id="folder-1"' in prompt
    assert "AP &amp; Docs" in prompt
    assert "A &lt; B &quot;说明&quot;" in prompt
    assert "id=1&amp;view=full" in prompt
    assert "cross-provider query" in prompt
    assert "resource_id as provider-native tool arguments" in prompt
    assert "explain why before broadening" in prompt


def test_render_selected_knowledge_prompt_ignores_invalid_refs() -> None:
    assert render_selected_knowledge_prompt([]) == ""
    assert render_selected_knowledge_prompt([{"provider": "demo"}]) == ""


def test_render_selected_knowledge_prompt_omits_empty_search_hints() -> None:
    prompt = render_selected_knowledge_prompt(
        [
            SelectedKnowledgeRef(
                provider="wegent",
                knowledge_base_id="12",
                knowledge_base_name="Vector Docs",
                retrieval_capabilities={
                    "retrieval_mode": "vector",
                    "semantic_query": False,
                    "keywords": False,
                    "phrases": False,
                },
            )
        ]
    )

    assert 'retrieval_mode="vector"' in prompt
    assert "search_hints=" not in prompt


def test_render_selected_knowledge_prompt_ignores_non_boolean_capabilities() -> None:
    prompt = render_selected_knowledge_prompt(
        [
            SelectedKnowledgeRef(
                provider="wegent",
                knowledge_base_id="12",
                knowledge_base_name="Vector Docs",
                retrieval_capabilities={
                    "retrieval_mode": "vector",
                    "semantic_query": "false",
                    "keywords": 1,
                    "phrases": [],
                },
            )
        ]
    )

    assert 'retrieval_mode="vector"' in prompt
    assert "search_hints=" not in prompt
