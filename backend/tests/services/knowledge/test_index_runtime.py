from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from app.services.knowledge.index_runtime import (
    KnowledgeBaseIndexInfo,
    build_kb_index_info,
    get_kb_index_info,
)


def test_build_kb_index_info_uses_current_user_for_default_namespace() -> None:
    db = MagicMock()
    knowledge_base = SimpleNamespace(
        namespace="default",
        user_id=42,
        json={"spec": {"summaryEnabled": True}},
    )

    kb_info = build_kb_index_info(
        db=db,
        knowledge_base=knowledge_base,
        current_user_id=7,
    )

    assert kb_info == KnowledgeBaseIndexInfo(
        index_owner_user_id=7,
        summary_enabled=True,
    )


def test_build_kb_index_info_uses_creator_for_group_namespace() -> None:
    db = MagicMock()
    knowledge_base = SimpleNamespace(
        namespace="team-a",
        user_id=42,
        json={"spec": {"summaryEnabled": False}},
    )

    with patch(
        "app.services.knowledge.index_runtime.is_organization_namespace",
        return_value=False,
    ) as is_org_namespace:
        kb_info = build_kb_index_info(
            db=db,
            knowledge_base=knowledge_base,
            current_user_id=7,
        )

    is_org_namespace.assert_called_once_with(db, "team-a")
    assert kb_info == KnowledgeBaseIndexInfo(
        index_owner_user_id=42,
        summary_enabled=False,
    )


def test_build_kb_index_info_uses_current_user_for_organization_namespace() -> None:
    db = MagicMock()
    knowledge_base = SimpleNamespace(
        namespace="org-a",
        user_id=42,
        json={"spec": {"summaryEnabled": True}},
    )

    with patch(
        "app.services.knowledge.index_runtime.is_organization_namespace",
        return_value=True,
    ) as is_org_namespace:
        kb_info = build_kb_index_info(
            db=db,
            knowledge_base=knowledge_base,
            current_user_id=7,
        )

    is_org_namespace.assert_called_once_with(db, "org-a")
    assert kb_info == KnowledgeBaseIndexInfo(
        index_owner_user_id=7,
        summary_enabled=True,
    )


def test_get_kb_index_info_falls_back_for_non_integer_id() -> None:
    db = MagicMock()

    kb_info = get_kb_index_info(
        db=db,
        knowledge_base_id="not-an-int",
        current_user_id=7,
    )

    db.query.assert_not_called()
    assert kb_info == KnowledgeBaseIndexInfo(
        index_owner_user_id=7,
        summary_enabled=False,
    )


def test_get_kb_index_info_falls_back_when_kb_is_missing() -> None:
    db = MagicMock()
    db.query.return_value.filter.return_value.first.return_value = None

    kb_info = get_kb_index_info(
        db=db,
        knowledge_base_id="9",
        current_user_id=7,
    )

    assert kb_info == KnowledgeBaseIndexInfo(
        index_owner_user_id=7,
        summary_enabled=False,
    )


def test_splitter_runtime_parser_supports_smart_type() -> None:
    from app.services.rag.splitter.runtime_config import parse_runtime_splitter_config

    splitter = parse_runtime_splitter_config({"type": "smart"})

    assert splitter.type == "smart"
