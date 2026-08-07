# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import json

import pytest

from app.models.subtask_context import ContextStatus, ContextType, SubtaskContext
from app.services.chat.preprocessing.contexts import (
    _build_knowledge_source_meta_prompt,
    build_external_knowledge_texts,
)


@pytest.mark.unit
def test_build_external_knowledge_texts_injects_persisted_chunks() -> None:
    context = SubtaskContext(
        subtask_id=12,
        user_id=7,
        context_type=ContextType.EXTERNAL_KNOWLEDGE.value,
        name="Quarterly",
        status=ContextStatus.READY.value,
        extracted_text=json.dumps(
            {
                "chunks": [
                    {
                        "content": "external plan content",
                        "source": "Plan.pdf",
                    }
                ]
            }
        ),
        type_data={
            "provider": "ap",
            "source_name": "Quarterly",
            "external_ref": {
                "provider": "ap",
                "id": "kb-1",
            },
        },
    )

    blocks = build_external_knowledge_texts([context])

    assert len(blocks) == 1
    assert "<external_knowledge>" in blocks[0]
    assert "Provider: ap" in blocks[0]
    assert "Source: Quarterly" in blocks[0]
    assert "[Plan.pdf]" in blocks[0]
    assert "external plan content" in blocks[0]


@pytest.mark.unit
def test_external_only_refs_build_non_empty_knowledge_source_metadata() -> None:
    meta_prompt = _build_knowledge_source_meta_prompt(
        internal_meta_prompt="",
        external_knowledge_refs=[
            {
                "provider": "dingtalk",
                "mode": "explicit",
                "id": "docs",
                "name": "DingTalk Docs",
                "scope": "personal",
                "target_type": "document",
                "target_name": "Roadmap.md",
            }
        ],
    )

    assert "External Knowledge Sources In Scope" in meta_prompt
    assert "Provider: dingtalk" in meta_prompt
    assert "Source Name: DingTalk Docs" in meta_prompt
    assert "Target Name: Roadmap.md" in meta_prompt
