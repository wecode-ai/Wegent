# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace
from unittest.mock import Mock, patch

from fastapi import HTTPException

from app.models.task import TaskResource
from app.services.chat.external_knowledge_refs import (
    remove_task_external_knowledge_ref,
    validate_external_knowledge_refs,
)
from app.services.chat.preprocessing.contexts import (
    _batch_update_and_insert_contexts,
    _prepare_contexts_for_creation,
    _sync_external_contexts_to_task,
    link_contexts_to_subtask,
)
from app.services.rag.sources import ExternalRefValidationError


def test_prepare_contexts_creates_internal_and_external_contexts() -> None:
    contexts = [
        SimpleNamespace(
            type="knowledge_base",
            data={
                "knowledge_id": 107,
                "name": "测试mcp",
                "document_count": 1,
            },
        ),
        SimpleNamespace(
            type="external_knowledge",
            data={
                "provider": "demo-source",
                "mode": "explicit",
                "id": "e686dce5-93f0-4363-95e0-13d5f80b5abd",
                "name": "测试1111",
                "scope": "organization",
            },
        ),
    ]

    kb_contexts, table_contexts, selected_docs_contexts, external_contexts = (
        _prepare_contexts_for_creation(
            contexts=contexts,
            subtask_id=166,
            user_id=2,
        )
    )

    assert table_contexts == []
    assert selected_docs_contexts == []
    assert len(kb_contexts) == 1
    assert kb_contexts[0].type_data == {
        "knowledge_id": 107,
        "document_count": 1,
        "scope_restricted": False,
    }
    assert len(external_contexts) == 1
    assert external_contexts[0].name == "测试1111"
    assert external_contexts[0].type_data == {
        "provider": "demo-source",
        "mode": "explicit",
        "id": "e686dce5-93f0-4363-95e0-13d5f80b5abd",
        "scope": "organization",
        "target_type": None,
        "node_id": None,
        "document_id": None,
        "parent_id": None,
        "target_name": None,
    }


def test_link_contexts_syncs_external_contexts_to_task_spec() -> None:
    db = Mock()
    task = Mock(spec=TaskResource)
    task.id = 71
    contexts = [
        SimpleNamespace(
            type="knowledge_base",
            data={
                "knowledge_id": 107,
                "name": "测试mcp",
                "document_count": 1,
            },
        ),
        SimpleNamespace(
            type="external_knowledge",
            data={
                "provider": "demo-source",
                "mode": "explicit",
                "id": "e686dce5-93f0-4363-95e0-13d5f80b5abd",
                "name": "测试1111",
                "scope": "organization",
            },
        ),
    ]

    with (
        patch(
            "app.services.chat.preprocessing.contexts._batch_update_and_insert_contexts",
            return_value=[83, 84],
        ) as batch_insert,
        patch(
            "app.services.chat.preprocessing.contexts._sync_kb_contexts_to_task"
        ) as sync_internal,
        patch(
            "app.services.chat.preprocessing.contexts._sync_external_contexts_to_task"
        ) as sync_external,
    ):
        linked_ids = link_contexts_to_subtask(
            db=db,
            subtask_id=166,
            user_id=2,
            contexts=contexts,
            task=task,
            user_name="wuhua3",
        )

    assert linked_ids == [83, 84]
    batch_insert.assert_called_once()
    sync_internal.assert_called_once()
    sync_external.assert_called_once()
    external_contexts = sync_external.call_args.args[1]
    assert len(external_contexts) == 1
    assert external_contexts[0].type_data["provider"] == "demo-source"


def test_sync_external_contexts_preserves_document_scope() -> None:
    db = Mock()
    task = Mock(spec=TaskResource)
    task.id = 71
    external_context = SimpleNamespace(
        name="api-reference.md",
        type_data={
            "provider": "demo-source",
            "mode": "explicit",
            "id": "kb-1",
            "name": "API Knowledge",
            "scope": "organization",
            "target_type": "document",
            "node_id": "document:node-1",
            "document_id": "document:node-1",
            "parent_id": "folder:parent-1",
            "target_name": "api-reference.md",
        },
    )

    with (
        patch(
            "app.services.chat.external_knowledge_refs.validate_external_knowledge_refs"
        ) as validate_refs,
        patch(
            "app.services.chat.external_knowledge_refs.sync_task_external_knowledge_refs",
            return_value=[
                {
                    "provider": "demo-source",
                    "mode": "explicit",
                    "id": "kb-1",
                    "name": "API Knowledge",
                    "scope": "organization",
                    "target_type": "document",
                    "node_id": "document:node-1",
                    "document_id": "document:node-1",
                    "parent_id": "folder:parent-1",
                    "target_name": "api-reference.md",
                }
            ],
        ) as sync_refs,
    ):
        _sync_external_contexts_to_task(db, [external_context], task)

    expected_refs = [
        {
            "provider": "demo-source",
            "mode": "explicit",
            "id": "kb-1",
            "name": "API Knowledge",
            "scope": "organization",
            "target_type": "document",
            "node_id": "document:node-1",
            "document_id": "document:node-1",
            "parent_id": "folder:parent-1",
            "target_name": "api-reference.md",
        }
    ]
    validate_refs.assert_called_once_with(
        expected_refs,
        binding_level="conversation",
    )
    sync_refs.assert_called_once_with(db, task, expected_refs)
    db.commit.assert_not_called()
    db.refresh.assert_not_called()


def test_validate_external_knowledge_refs_wraps_value_errors() -> None:
    with patch(
        "app.services.rag.sources.validate_external_refs",
        side_effect=ValueError("too many sources"),
    ):
        try:
            validate_external_knowledge_refs(
                [{"provider": "demo-source", "mode": "explicit", "id": "kb-1"}],
                binding_level="conversation",
            )
        except ExternalRefValidationError as exc:
            assert str(exc) == "too many sources"
        else:
            raise AssertionError("Expected ExternalRefValidationError")


def test_validate_external_knowledge_refs_wraps_pydantic_errors() -> None:
    try:
        validate_external_knowledge_refs(
            [{"provider": "demo-source", "mode": "explicit"}],
            binding_level="conversation",
        )
    except ExternalRefValidationError as exc:
        assert "id is required when mode is explicit" in str(exc)
    else:
        raise AssertionError("Expected ExternalRefValidationError")


def test_remove_task_external_knowledge_ref_removes_only_matching_target() -> None:
    db = Mock()
    task = Mock(spec=TaskResource)
    task.json = {
        "spec": {
            "externalKnowledgeRefs": [
                {
                    "provider": "demo-source",
                    "mode": "explicit",
                    "id": "kb-1",
                    "name": "Demo source",
                },
                {
                    "provider": "demo-source",
                    "mode": "explicit",
                    "id": "kb-1",
                    "name": "Demo source",
                    "target_type": "document",
                    "node_id": "document:node-1",
                    "document_id": "node-1",
                    "target_name": "api-reference.md",
                },
            ]
        }
    }

    with patch(
        "app.services.chat.external_knowledge_refs.task_stores.task_store.update_json"
    ):
        next_refs = remove_task_external_knowledge_ref(
            db,
            task,
            {
                "provider": "demo-source",
                "mode": "explicit",
                "id": "kb-1",
                "target_type": "document",
                "node_id": "document:node-1",
                "document_id": "node-1",
            },
        )

    assert next_refs == [
        {
            "provider": "demo-source",
            "mode": "explicit",
            "id": "kb-1",
            "name": "Demo source",
        }
    ]
    db.commit.assert_not_called()


def test_sync_external_contexts_raises_validation_errors_without_syncing() -> None:
    db = Mock()
    task = Mock(spec=TaskResource)
    task.id = 71
    external_context = SimpleNamespace(
        name="Too many",
        type_data={
            "provider": "demo-source",
            "mode": "explicit",
            "id": "kb-1",
        },
    )

    with (
        patch(
            "app.services.chat.external_knowledge_refs.validate_external_knowledge_refs",
            side_effect=ValueError("too many sources"),
        ) as validate_refs,
        patch(
            "app.services.chat.external_knowledge_refs.sync_task_external_knowledge_refs"
        ) as sync_refs,
    ):
        try:
            _sync_external_contexts_to_task(db, [external_context], task)
        except ValueError as exc:
            assert str(exc) == "too many sources"
        else:
            raise AssertionError("Expected validation error")

    validate_refs.assert_called_once()
    sync_refs.assert_not_called()
    db.commit.assert_not_called()


def test_link_contexts_returns_bad_request_for_external_ref_validation_errors() -> None:
    db = Mock()
    task = Mock(spec=TaskResource)
    task.id = 71
    contexts = [
        SimpleNamespace(
            type="external_knowledge",
            data={
                "provider": "demo-source",
                "mode": "explicit",
                "id": "kb-1",
                "name": "Demo source",
            },
        )
    ]

    with (
        patch(
            "app.services.chat.preprocessing.contexts._batch_update_and_insert_contexts",
            return_value=[83],
        ),
        patch(
            "app.services.chat.preprocessing.contexts._sync_external_contexts_to_task",
            side_effect=ExternalRefValidationError("too many external sources"),
        ),
    ):
        try:
            link_contexts_to_subtask(
                db=db,
                subtask_id=166,
                user_id=2,
                contexts=contexts,
                task=task,
                user_name="wuhua3",
            )
        except HTTPException as exc:
            assert exc.status_code == 400
            assert exc.detail == "too many external sources"
        else:
            raise AssertionError("Expected HTTPException")

    db.rollback.assert_called_once()
    db.commit.assert_not_called()


def test_batch_update_and_insert_contexts_flushes_without_commit() -> None:
    db = Mock()
    context = Mock()
    context.id = 88
    context.context_type = "external_knowledge"
    context.name = "Demo source"
    context.type_data = {"provider": "demo-source"}

    created_ids = _batch_update_and_insert_contexts(
        db=db,
        attachment_ids=None,
        contexts_to_create=[context],
        subtask_id=166,
    )

    assert created_ids == [88]
    db.add_all.assert_called_once_with([context])
    db.flush.assert_called_once()
    db.commit.assert_not_called()
