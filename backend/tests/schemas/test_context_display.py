# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest

from app.schemas.context_display import build_public_context_display_fields


@pytest.mark.unit
def test_public_external_knowledge_display_fields_are_share_safe() -> None:
    fields = build_public_context_display_fields(
        "external_knowledge",
        {
            "external_ref": {
                "provider": "dingtalk",
                "mode": "explicit",
                "id": "docs",
                "name": "DingTalk Docs",
                "scope": "personal",
                "target_type": "document",
                "node_id": "node-1",
                "document_id": "doc-1",
                "parent_id": "folder-1",
                "target_name": "Roadmap.md",
            },
            "retrieval_status": {"searched": True, "ignored": False},
        },
    )

    assert fields == {
        "external_provider": "dingtalk",
        "external_provider_label": "DingTalk",
        "external_source_name": "DingTalk Docs",
        "external_target_name": "Roadmap.md",
        "external_target_type": "document",
        "retrieval_status": {"searched": True, "ignored": False},
    }
    assert "external_ref" not in fields
    assert "external_id" not in fields
    assert "external_node_id" not in fields
    assert "external_document_id" not in fields
    assert "external_parent_id" not in fields
