# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for request-scoped and task-default knowledge base behavior.

This module tests the following features:
1. Knowledge base priority logic (message selection > Task defaults)
2. Scoped internal knowledge selection handling
3. Manual Task binding deduplication and limit enforcement
4. ID-based lookup and automatic migration from name-only refs

NOTE:
- KB meta prompt formatting is tested separately in chat preprocessing.
"""

from types import SimpleNamespace
from unittest.mock import MagicMock, Mock, patch

import pytest
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.subtask_context import SubtaskContext
from app.models.task import TaskResource
from app.services.knowledge import TaskKnowledgeBaseService
from app.services.knowledge.task_knowledge_base_service import (
    project_task_knowledge_bindings,
)
from shared.models.knowledge import KnowledgeBaseScope


@pytest.mark.unit
class TestPrepareContextsForCreation:
    """Test generic context creation payload normalization."""

    def test_preserves_explicit_empty_knowledge_base_scope(self):
        from app.services.chat.preprocessing.contexts import (
            _prepare_contexts_for_creation,
        )

        context_item = SimpleNamespace(
            type="knowledge_base",
            data={
                "knowledge_id": 10,
                "name": "Empty Folder Scope",
                "scope_restricted": True,
                "document_ids": [],
            },
        )

        (
            kb_contexts,
            table_contexts,
            selected_docs_contexts,
            external_contexts,
        ) = _prepare_contexts_for_creation(
            contexts=[context_item],
            subtask_id=100,
            user_id=1,
        )

        assert len(kb_contexts) == 1
        assert table_contexts == []
        assert selected_docs_contexts == []
        assert external_contexts == []
        assert kb_contexts[0].type_data == {
            "knowledge_id": 10,
            "document_count": None,
            "scope_restricted": True,
            "document_ids": [],
        }

    def test_legacy_empty_knowledge_base_scope_remains_unrestricted(self):
        from app.services.chat.preprocessing.contexts import (
            _prepare_contexts_for_creation,
        )

        context_item = SimpleNamespace(
            type="knowledge_base",
            data={
                "knowledge_id": 10,
                "name": "Whole KB",
                "document_ids": [],
            },
        )

        kb_contexts, _, _, external_contexts = _prepare_contexts_for_creation(
            contexts=[context_item],
            subtask_id=100,
            user_id=1,
        )

        assert len(kb_contexts) == 1
        assert external_contexts == []
        assert kb_contexts[0].type_data == {
            "knowledge_id": 10,
            "document_count": None,
            "scope_restricted": False,
        }

    def test_legacy_document_ids_imply_restricted_scope(self):
        from app.services.chat.preprocessing.contexts import (
            _prepare_contexts_for_creation,
        )

        context_item = SimpleNamespace(
            type="knowledge_base",
            data={
                "knowledge_id": 10,
                "name": "Selected Documents",
                "document_ids": [101, 102],
            },
        )

        kb_contexts, _, _, external_contexts = _prepare_contexts_for_creation(
            contexts=[context_item],
            subtask_id=100,
            user_id=1,
        )

        assert len(kb_contexts) == 1
        assert external_contexts == []
        assert kb_contexts[0].type_data == {
            "knowledge_id": 10,
            "document_count": None,
            "scope_restricted": True,
            "document_ids": [101, 102],
        }

    def test_document_ids_remain_restricted_with_explicit_false(self):
        from app.services.chat.preprocessing.contexts import (
            _prepare_contexts_for_creation,
        )

        context_item = SimpleNamespace(
            type="knowledge_base",
            data={
                "knowledge_id": 10,
                "name": "Selected Documents",
                "scope_restricted": False,
                "document_ids": [101],
            },
        )

        kb_contexts, _, _, external_contexts = _prepare_contexts_for_creation(
            contexts=[context_item],
            subtask_id=100,
            user_id=1,
        )

        assert len(kb_contexts) == 1
        assert external_contexts == []
        assert kb_contexts[0].type_data == {
            "knowledge_id": 10,
            "document_count": None,
            "scope_restricted": True,
            "document_ids": [101],
        }

    def test_empty_restricted_context_builds_empty_restricted_scope(self):
        from app.services.chat.preprocessing.contexts import (
            _build_scopes_from_kb_contexts,
            _prepare_contexts_for_creation,
        )

        context_item = SimpleNamespace(
            type="knowledge_base",
            data={
                "knowledge_id": 10,
                "name": "Empty Folder Scope",
                "scope_restricted": True,
                "document_ids": [],
            },
        )

        kb_contexts, _, _, external_contexts = _prepare_contexts_for_creation(
            contexts=[context_item],
            subtask_id=100,
            user_id=1,
        )
        scopes = _build_scopes_from_kb_contexts(kb_contexts)

        assert external_contexts == []
        assert len(scopes) == 1
        assert scopes[0].knowledge_base_id == 10
        assert scopes[0].scope_restricted is True
        assert scopes[0].document_ids == []

    def test_folder_scope_is_preserved_for_backend_resolution(self):
        from app.services.chat.preprocessing.contexts import (
            _prepare_contexts_for_creation,
        )

        context_item = SimpleNamespace(
            type="knowledge_base",
            data={
                "knowledge_id": 10,
                "name": "Folder Scope",
                "scope_restricted": True,
                "folder_ids": [5],
                "folder_names": ["Specs"],
                "include_subfolders": True,
            },
        )

        kb_contexts, _, _, external_contexts = _prepare_contexts_for_creation(
            contexts=[context_item],
            subtask_id=100,
            user_id=1,
        )

        assert external_contexts == []
        assert len(kb_contexts) == 1
        assert kb_contexts[0].type_data == {
            "knowledge_id": 10,
            "document_count": None,
            "scope_restricted": True,
            "document_ids": [],
            "folder_ids": [5],
            "include_subfolders": True,
            "folder_names": ["Specs"],
        }


@pytest.mark.unit
class TestKBPriorityLogic:
    """Test knowledge base priority logic in _prepare_kb_tools_from_contexts"""

    @pytest.fixture
    def mock_db(self):
        """Create a mock database session"""
        return Mock(spec=Session)

    def test_subtask_kb_takes_priority(self, mock_db):
        """Test that subtask-level KB takes priority over task-level KB"""
        from app.services.chat.preprocessing.contexts import (
            _prepare_kb_tools_from_contexts,
        )

        # Create subtask KB contexts
        kb_context = Mock(spec=SubtaskContext)
        kb_context.knowledge_id = 10
        kb_context.type_data = None

        # Mock task-level KB (should be ignored when subtask has KB)
        with patch(
            "app.services.chat.preprocessing.contexts._get_bound_knowledge_base_ids"
        ) as mock_get_bound:
            mock_get_bound.return_value = [20, 30]  # Task-level KBs

            with patch("chat_shell.tools.builtin.KnowledgeBaseTool") as mock_kb_tool:
                mock_kb_tool.return_value = Mock()

                with patch(
                    "app.services.chat.preprocessing.contexts._get_user_kb_tool_access_mode",
                    return_value=("full", ""),
                ):
                    kb_result = _prepare_kb_tools_from_contexts(
                        kb_contexts=[kb_context],
                        user_id=1,
                        db=mock_db,
                        base_system_prompt="Base prompt",
                        task_id=100,
                        user_subtask_id=1,
                    )

                    # Should use only subtask KB (10), not task-level (20, 30)
                    mock_kb_tool.assert_called_once()
                    call_args = mock_kb_tool.call_args
                    assert call_args[1]["knowledge_base_ids"] == [10]
                    assert len(kb_result.extra_tools) == 1

    def test_scoped_context_uses_scopes_without_legacy_document_filters(self, mock_db):
        """Scoped document IDs should only be represented by per-KB scopes."""
        from app.services.chat.preprocessing.contexts import (
            _prepare_kb_tools_from_contexts,
        )

        kb_context = Mock(spec=SubtaskContext)
        kb_context.knowledge_id = 10
        kb_context.type_data = {
            "scope_restricted": True,
            "document_ids": [101, 102],
        }

        with patch(
            "app.services.chat.preprocessing.contexts.KnowledgeFolderService.resolve_document_ids_for_scope",
            return_value=[101, 102],
        ):
            with patch(
                "app.services.chat.preprocessing.contexts._get_bound_knowledge_base_ids"
            ) as mock_get_bound:
                mock_get_bound.return_value = []

                with patch(
                    "chat_shell.tools.builtin.ScopedKnowledgeBaseTool"
                ) as mock_scoped_tool:
                    mock_scoped_tool.return_value = Mock()

                    with patch(
                        "app.services.chat.preprocessing.contexts._get_user_kb_tool_access_mode",
                        return_value=("full", ""),
                    ):
                        kb_result = _prepare_kb_tools_from_contexts(
                            kb_contexts=[kb_context],
                            user_id=1,
                            db=mock_db,
                            base_system_prompt="Base prompt",
                            task_id=100,
                            user_subtask_id=1,
                        )

        mock_scoped_tool.assert_called_once()
        call_kwargs = mock_scoped_tool.call_args.kwargs
        assert call_kwargs["knowledge_base_ids"] == [10]
        assert call_kwargs["document_ids"] == []
        assert len(call_kwargs["knowledge_base_scopes"]) == 1
        scope = call_kwargs["knowledge_base_scopes"][0]
        assert scope.knowledge_base_id == 10
        assert scope.scope_restricted is True
        assert scope.document_ids == [101, 102]
        assert kb_result.document_ids == []

    def test_folder_scope_resolves_to_document_ids(self, mock_db):
        """Folder scope should be validated and resolved before reaching RAG."""
        from app.services.chat.preprocessing.contexts import (
            _prepare_kb_tools_from_contexts,
        )

        kb_context = Mock(spec=SubtaskContext)
        kb_context.knowledge_id = 10
        kb_context.type_data = {
            "scope_restricted": True,
            "folder_ids": [5],
            "document_ids": [101],
            "include_subfolders": True,
        }

        with patch(
            "app.services.chat.preprocessing.contexts.KnowledgeFolderService.resolve_document_ids_for_scope",
            return_value=[101, 102],
        ) as mock_resolve:
            with patch(
                "app.services.chat.preprocessing.contexts._get_bound_knowledge_base_ids",
                return_value=[],
            ):
                with patch(
                    "chat_shell.tools.builtin.ScopedKnowledgeBaseTool"
                ) as mock_scoped_tool:
                    mock_scoped_tool.return_value = Mock()
                    with patch(
                        "app.services.chat.preprocessing.contexts._get_user_kb_tool_access_mode",
                        return_value=("full", ""),
                    ):
                        kb_result = _prepare_kb_tools_from_contexts(
                            kb_contexts=[kb_context],
                            user_id=1,
                            db=mock_db,
                            base_system_prompt="Base prompt",
                            task_id=100,
                            user_subtask_id=1,
                        )

        mock_resolve.assert_called_once_with(
            mock_db,
            knowledge_base_id=10,
            user_id=1,
            folder_ids=[5],
            document_ids=[101],
            include_subfolders=True,
        )
        scope = mock_scoped_tool.call_args.kwargs["knowledge_base_scopes"][0]
        assert scope.knowledge_base_id == 10
        assert scope.scope_restricted is True
        assert scope.document_ids == [101, 102]
        assert kb_result.document_ids == []
        assert kb_result.knowledge_base_scopes == [scope]

    def test_task_defaults_merge_scoped_and_unscoped_knowledge_bases(self, mock_db):
        """A scoped KB must not hide other unscoped Task-level KBs."""
        from app.services.chat.preprocessing.contexts import (
            _prepare_kb_tools_from_contexts,
        )

        scoped_kb = KnowledgeBaseScope(
            knowledge_base_id=10,
            scope_restricted=True,
            document_ids=[101, 102],
        )
        with (
            patch(
                "app.services.chat.preprocessing.contexts._get_bound_knowledge_base_scopes",
                return_value=[scoped_kb],
            ),
            patch(
                "app.services.chat.preprocessing.contexts._get_bound_knowledge_base_ids",
                return_value=[10, 20],
            ),
            patch("chat_shell.tools.builtin.ScopedKnowledgeBaseTool") as mock_kb_tool,
            patch(
                "app.services.chat.preprocessing.contexts._get_user_kb_tool_access_mode",
                return_value=("full", ""),
            ),
        ):
            mock_kb_tool.return_value = Mock()
            result = _prepare_kb_tools_from_contexts(
                kb_contexts=[],
                user_id=1,
                db=mock_db,
                base_system_prompt="Base prompt",
                task_id=100,
                user_subtask_id=1,
            )

        call_kwargs = mock_kb_tool.call_args.kwargs
        assert call_kwargs["knowledge_base_ids"] == [10, 20]
        assert call_kwargs["knowledge_base_scopes"] == [
            scoped_kb,
            KnowledgeBaseScope(knowledge_base_id=20),
        ]
        assert result.knowledge_base_ids == [10, 20]

    def test_fallback_to_task_kb_when_no_subtask_kb(self, mock_db):
        """Test that task-level KB is used when subtask has no KB"""
        from app.services.chat.preprocessing.contexts import (
            _prepare_kb_tools_from_contexts,
        )

        # No subtask KB contexts
        with patch(
            "app.services.chat.preprocessing.contexts._get_bound_knowledge_base_ids"
        ) as mock_get_bound:
            mock_get_bound.return_value = [20, 30]  # Task-level KBs

            with patch("chat_shell.tools.builtin.KnowledgeBaseTool") as mock_kb_tool:
                mock_kb_tool.return_value = Mock()

                with patch(
                    "app.services.chat.preprocessing.contexts._get_user_kb_tool_access_mode",
                    return_value=("full", ""),
                ):
                    kb_result = _prepare_kb_tools_from_contexts(
                        kb_contexts=[],  # No subtask KB
                        user_id=1,
                        db=mock_db,
                        base_system_prompt="Base prompt",
                        task_id=100,
                        user_subtask_id=1,
                    )

                    # Should use task-level KBs (20, 30)
                    mock_kb_tool.assert_called_once()
                    call_args = mock_kb_tool.call_args
                    assert set(call_args[1]["knowledge_base_ids"]) == {20, 30}
                    assert len(kb_result.extra_tools) == 1

    def test_restricted_analyst_uses_search_only_mode(self, mock_db):
        """Restricted Analysts should get search-only KB access instead of full denial."""
        from app.services.chat.preprocessing.contexts import (
            _prepare_kb_tools_from_contexts,
        )

        kb_context = Mock(spec=SubtaskContext)
        kb_context.knowledge_id = 10
        kb_context.type_data = None

        with patch(
            "app.services.chat.preprocessing.contexts._get_bound_knowledge_base_ids"
        ) as mock_get_bound:
            mock_get_bound.return_value = []

            with patch("chat_shell.tools.builtin.KnowledgeBaseTool") as mock_kb_tool:
                mock_kb_tool.return_value = Mock()

                with patch(
                    "app.services.chat.preprocessing.contexts._get_user_kb_tool_access_mode",
                    return_value=("restricted_search_only", "test reason"),
                ):
                    with patch(
                        "app.services.chat.preprocessing.contexts._build_kb_meta_prompt",
                        return_value=(
                            "Restricted Knowledge Bases In Scope:\n"
                            "- KB Name: Test KB, KB ID: 10"
                        ),
                    ):
                        kb_result = _prepare_kb_tools_from_contexts(
                            kb_contexts=[kb_context],
                            user_id=1,
                            db=mock_db,
                            base_system_prompt="Base prompt",
                            task_id=100,
                            user_subtask_id=1,
                            model_config={"model_id": "gpt-test"},
                        )

                    mock_kb_tool.assert_called_once()
                    call_args = mock_kb_tool.call_args
                    assert call_args[1]["knowledge_base_ids"] == [10]
                    assert call_args[1]["injection_mode"] == "hybrid"
                    assert call_args[1]["tool_access_mode"] == "restricted_search_only"
                    assert call_args[1]["current_model_name"] is None
                    assert call_args[1]["current_model_namespace"] == "default"
                    assert len(kb_result.extra_tools) == 1
                    assert kb_result.knowledge_base_ids == [10]
                    assert "Restricted Knowledge Bases In Scope" in (
                        kb_result.kb_meta_prompt
                    )
                    assert "KB ID: 10" in kb_result.kb_meta_prompt
                    assert "Summary:" not in kb_result.kb_meta_prompt
                    assert kb_result.kb_tool_access_mode == "restricted_search_only"
                    assert "Knowledge Base Restricted Analysis" in (
                        kb_result.enhanced_system_prompt
                    )

    def test_no_kb_when_both_empty(self, mock_db):
        """Test that no KB tool is created when both levels have no KB"""
        from app.services.chat.preprocessing.contexts import (
            _prepare_kb_tools_from_contexts,
        )

        with patch(
            "app.services.chat.preprocessing.contexts._get_bound_knowledge_base_ids"
        ) as mock_get_bound:
            mock_get_bound.return_value = []  # No task-level KBs

            kb_result = _prepare_kb_tools_from_contexts(
                kb_contexts=[],  # No subtask KB
                user_id=1,
                db=mock_db,
                base_system_prompt="Base prompt",
                task_id=100,
                user_subtask_id=1,
            )

            # Should return empty tools
            assert kb_result.extra_tools == []
            assert kb_result.enhanced_system_prompt == "Base prompt"
            assert kb_result.kb_meta_prompt == ""
            # New KB fields must also default to empty/False
            assert kb_result.knowledge_base_ids == []
            assert kb_result.is_user_selected_kb is False
            assert kb_result.document_ids == []
            assert kb_result.kb_tool_access_mode == "full"


@pytest.mark.unit
class TestGetBoundKnowledgeBaseIds:
    """Test _get_bound_knowledge_base_ids function"""

    @pytest.fixture
    def mock_db(self):
        """Create a mock database session"""
        return Mock(spec=Session)

    def test_get_bound_kb_ids_for_non_group_chat(self, mock_db):
        """Test that KBs are returned for non-group chat tasks too"""
        from app.services.chat.preprocessing.contexts import (
            _get_bound_knowledge_base_ids,
        )

        # Create mock task (non-group chat) with KB refs
        mock_task = Mock(spec=TaskResource)
        mock_task.json = {
            "spec": {
                "is_group_chat": False,
                "knowledgeBaseRefs": [
                    {"name": "Test KB", "namespace": "default"},
                ],
            }
        }

        # Create mock KB
        mock_kb = Mock(spec=Kind)
        mock_kb.id = 10
        mock_kb.json = {"spec": {"name": "Test KB"}}

        mock_query = MagicMock()
        mock_db.query.return_value = mock_query
        mock_query.filter.return_value = mock_query
        mock_query.first.return_value = mock_task
        mock_query.all.return_value = [mock_kb]

        with patch(
            "app.services.knowledge.knowledge_service.KnowledgeService.can_directly_access_knowledge_base",
            return_value=True,
        ):
            result = _get_bound_knowledge_base_ids(mock_db, task_id=100, user_id=1)

        # Should return the KB ID even for non-group chat
        assert result == [10]

    def test_get_bound_kb_ids_empty_refs(self, mock_db):
        """Test that empty list is returned when no KB refs"""
        from app.services.chat.preprocessing.contexts import (
            _get_bound_knowledge_base_ids,
        )

        mock_task = Mock(spec=TaskResource)
        mock_task.json = {
            "spec": {
                "is_group_chat": True,
                "knowledgeBaseRefs": [],
            }
        }

        mock_query = MagicMock()
        mock_db.query.return_value = mock_query
        mock_query.filter.return_value = mock_query
        mock_query.first.return_value = mock_task

        result = _get_bound_knowledge_base_ids(mock_db, task_id=100, user_id=1)

        assert result == []

    def test_get_bound_kb_ids_task_not_found(self, mock_db):
        """Test that empty list is returned when task not found"""
        from app.services.chat.preprocessing.contexts import (
            _get_bound_knowledge_base_ids,
        )

        mock_query = MagicMock()
        mock_db.query.return_value = mock_query
        mock_query.filter.return_value = mock_query
        mock_query.first.return_value = None

        result = _get_bound_knowledge_base_ids(mock_db, task_id=999, user_id=1)

        assert result == []


@pytest.mark.unit
def test_bound_folder_scope_is_resolved_as_task_owner():
    from app.services.chat.preprocessing.contexts import (
        _get_bound_knowledge_base_scopes,
    )
    from app.services.openapi.kb_resolver import (
        KnowledgeBaseResolutionResult,
        ResolvedKnowledgeBase,
    )

    db = Mock(spec=Session)
    task = Mock(spec=TaskResource)
    task.json = {
        "spec": {
            "teamRef": {"user_id": 9},
            "knowledgeBaseScopes": [
                {
                    "id": 10,
                    "namespace": "default",
                    "name": "Folder KB",
                    "scopeRestricted": True,
                    "folderIds": [5],
                    "explicitDocumentIds": [101],
                    "includeSubfolders": True,
                }
            ],
        }
    }
    resolved = ResolvedKnowledgeBase(
        kb_id=10,
        namespace="default",
        name="Folder KB",
        display_name="Folder KB",
        scope_restricted=True,
        folder_ids=[5],
        explicit_document_ids=[101],
        include_subfolders=True,
        resolved_document_ids=[101, 102],
    )

    with (
        patch(
            "app.services.knowledge.task_knowledge_base_service."
            "task_knowledge_base_service.get_task",
            return_value=task,
        ),
        patch(
            "app.services.chat.knowledge_binding_resolver."
            "KnowledgeBindingResolver.resolve_task_owner_user",
            return_value=SimpleNamespace(id=9),
        ),
        patch(
            "app.services.openapi.kb_resolver.KnowledgeBaseNameResolver.resolve",
            return_value=KnowledgeBaseResolutionResult([resolved], [], []),
        ) as resolve,
    ):
        scopes = _get_bound_knowledge_base_scopes(db, task_id=71)

    resolve.assert_called_once_with(
        [
            {
                "id": 10,
                "namespace": "default",
                "name": "Folder KB",
                "folder_ids": [5],
                "document_ids": [101],
                "include_subfolders": True,
                "scope_specified": True,
            }
        ],
        raise_on_error=True,
    )
    assert scopes == [
        KnowledgeBaseScope(
            knowledge_base_id=10,
            scope_restricted=True,
            document_ids=[101, 102],
        )
    ]


def _scoped_task() -> Mock:
    """Build a Task with a single restricted (scoped) knowledge base binding."""
    task = Mock(spec=TaskResource)
    task.json = {
        "spec": {
            "teamRef": {"user_id": 9},
            "knowledgeBaseScopes": [
                {
                    "id": 10,
                    "namespace": "default",
                    "name": "Folder KB",
                    "scopeRestricted": True,
                    "folderIds": [5],
                    "explicitDocumentIds": [101],
                    "includeSubfolders": True,
                }
            ],
        }
    }
    return task


@pytest.mark.unit
def test_get_bound_kb_scopes_reraises_resolver_http_exception():
    """A resolver HTTPException must propagate, never degrade to an empty scope.

    Returning [] here would let complete_knowledge_base_scopes fabricate an
    unrestricted (whole-KB) scope for the still-present KB id, silently widening
    a restricted binding.
    """
    from fastapi import HTTPException

    from app.services.chat.preprocessing.contexts import (
        _get_bound_knowledge_base_scopes,
    )

    db = Mock(spec=Session)
    task = _scoped_task()

    with (
        patch(
            "app.services.knowledge.task_knowledge_base_service."
            "task_knowledge_base_service.get_task",
            return_value=task,
        ),
        patch(
            "app.services.chat.knowledge_binding_resolver."
            "KnowledgeBindingResolver.resolve_task_owner_user",
            return_value=SimpleNamespace(id=9),
        ),
        patch(
            "app.services.openapi.kb_resolver.KnowledgeBaseNameResolver.resolve",
            side_effect=HTTPException(status_code=404, detail="KB not found"),
        ),
    ):
        with pytest.raises(HTTPException) as exc_info:
            _get_bound_knowledge_base_scopes(db, task_id=71)

    assert exc_info.value.status_code == 404


@pytest.mark.unit
def test_get_bound_kb_scopes_raises_conflict_when_owner_unresolved():
    """Scoped refs present but owner unresolved must fail closed with 409."""
    from fastapi import HTTPException, status

    from app.services.chat.preprocessing.contexts import (
        _get_bound_knowledge_base_scopes,
    )

    db = Mock(spec=Session)
    task = _scoped_task()

    with (
        patch(
            "app.services.knowledge.task_knowledge_base_service."
            "task_knowledge_base_service.get_task",
            return_value=task,
        ),
        patch(
            "app.services.chat.knowledge_binding_resolver."
            "KnowledgeBindingResolver.resolve_task_owner_user",
            return_value=None,
        ),
        patch(
            "app.services.openapi.kb_resolver.KnowledgeBaseNameResolver.resolve",
        ) as resolve,
    ):
        with pytest.raises(HTTPException) as exc_info:
            _get_bound_knowledge_base_scopes(db, task_id=71)

    assert exc_info.value.status_code == status.HTTP_409_CONFLICT
    resolve.assert_not_called()


@pytest.mark.unit
def test_get_bound_kb_scopes_returns_empty_when_no_bindings():
    """A task with no knowledge base bindings is a legitimate empty result."""
    from app.services.chat.preprocessing.contexts import (
        _get_bound_knowledge_base_scopes,
    )

    db = Mock(spec=Session)
    task = Mock(spec=TaskResource)
    task.json = {"spec": {"teamRef": {"user_id": 9}}}

    with patch(
        "app.services.knowledge.task_knowledge_base_service."
        "task_knowledge_base_service.get_task",
        return_value=task,
    ):
        scopes = _get_bound_knowledge_base_scopes(db, task_id=71)

    assert scopes == []


@pytest.mark.unit
def test_prepare_kb_tools_fails_closed_when_scope_resolution_fails():
    """The tool-preparation chain must fail closed when scope resolution fails.

    _get_bound_knowledge_base_ids still returns the restricted KB id, but scope
    resolution raises. The request must propagate the error rather than build an
    unrestricted whole-KB retrieval tool.
    """
    from fastapi import HTTPException

    from app.services.chat.preprocessing.contexts import (
        _prepare_kb_tools_from_contexts,
    )

    db = Mock(spec=Session)
    task = _scoped_task()

    with (
        patch(
            "app.services.chat.preprocessing.contexts._get_bound_knowledge_base_ids",
            return_value=[10],
        ),
        patch(
            "app.services.knowledge.task_knowledge_base_service."
            "task_knowledge_base_service.get_task",
            return_value=task,
        ),
        patch(
            "app.services.chat.knowledge_binding_resolver."
            "KnowledgeBindingResolver.resolve_task_owner_user",
            return_value=SimpleNamespace(id=9),
        ),
        patch(
            "app.services.openapi.kb_resolver.KnowledgeBaseNameResolver.resolve",
            side_effect=HTTPException(status_code=403, detail="No access"),
        ),
        patch("chat_shell.tools.builtin.KnowledgeBaseTool") as mock_kb_tool,
        patch(
            "chat_shell.tools.builtin.ScopedKnowledgeBaseTool"
        ) as mock_scoped_kb_tool,
    ):
        with pytest.raises(HTTPException) as exc_info:
            _prepare_kb_tools_from_contexts(
                kb_contexts=[],
                user_id=1,
                db=db,
                base_system_prompt="Base prompt",
                task_id=100,
                user_subtask_id=1,
            )

    assert exc_info.value.status_code == 403
    mock_kb_tool.assert_not_called()
    mock_scoped_kb_tool.assert_not_called()


@pytest.mark.unit
class TestKBRefIdBasedLookup:
    """Test ID-based lookup and migration for KB references"""

    @pytest.fixture
    def mock_db(self):
        """Create a mock database session"""
        return Mock(spec=Session)

    @pytest.fixture
    def service(self):
        """Create TaskKnowledgeBaseService instance"""
        return TaskKnowledgeBaseService()

    @pytest.fixture
    def mock_knowledge_base(self):
        """Create a mock knowledge base"""
        kb = Mock(spec=Kind)
        kb.id = 10
        kb.kind = "KnowledgeBase"
        kb.namespace = "default"
        kb.is_active = True
        kb.json = {"spec": {"name": "Test KB", "description": "Test knowledge base"}}
        return kb

    def test_get_kb_by_id_priority(self, service, mock_db, mock_knowledge_base):
        """Test that ID lookup takes priority over name lookup"""
        # Setup mock for get_knowledge_base_by_id
        with patch.object(
            service, "get_knowledge_base_by_id", return_value=mock_knowledge_base
        ) as mock_by_id:
            with patch.object(service, "get_knowledge_base_by_name") as mock_by_name:
                ref = {"id": 10, "name": "Test KB", "namespace": "default"}
                kb, needs_migration = service.get_knowledge_base_by_ref(mock_db, ref)

                # Should use ID lookup
                mock_by_id.assert_called_once_with(mock_db, 10)
                # Should NOT use name lookup
                mock_by_name.assert_not_called()
                assert kb == mock_knowledge_base
                assert needs_migration is False

    def test_get_kb_by_name_fallback(self, service, mock_db, mock_knowledge_base):
        """Test that name lookup is used when ID is None"""
        with patch.object(service, "get_knowledge_base_by_id") as mock_by_id:
            with patch.object(
                service, "get_knowledge_base_by_name", return_value=mock_knowledge_base
            ) as mock_by_name:
                # Ref without ID (legacy data)
                ref = {"name": "Test KB", "namespace": "default"}
                kb, needs_migration = service.get_knowledge_base_by_ref(mock_db, ref)

                # Should NOT use ID lookup (id is None)
                mock_by_id.assert_not_called()
                # Should use name lookup
                mock_by_name.assert_called_once_with(mock_db, "Test KB", "default")
                assert kb == mock_knowledge_base
                assert needs_migration is True

    def test_get_kb_by_id_not_found(self, service, mock_db):
        """Test handling when KB is not found by ID (possibly deleted)"""
        with patch.object(
            service, "get_knowledge_base_by_id", return_value=None
        ) as mock_by_id:
            with patch.object(service, "get_knowledge_base_by_name") as mock_by_name:
                ref = {"id": 999, "name": "Deleted KB", "namespace": "default"}
                kb, needs_migration = service.get_knowledge_base_by_ref(mock_db, ref)

                # Should try ID lookup
                mock_by_id.assert_called_once_with(mock_db, 999)
                # Should NOT fall back to name (ID was provided but not found)
                mock_by_name.assert_not_called()
                assert kb is None
                assert needs_migration is False

    def test_bind_kb_includes_id(self, service, mock_db, mock_knowledge_base):
        """Test that new bindings include the ID field"""
        mock_task = Mock(spec=TaskResource)
        mock_task.id = 100
        mock_task.json = {
            "spec": {
                "title": "Test Task",
                "is_group_chat": True,
                "knowledgeBaseRefs": [],
            }
        }

        mock_user = Mock()
        mock_user.user_name = "testuser"

        mock_query = MagicMock()
        mock_db.query.return_value = mock_query
        mock_query.filter.return_value = mock_query

        with patch(
            "app.services.knowledge.task_knowledge_base_service.task_store.get_by_id_for_update",
            return_value=mock_task,
        ):
            with patch.object(service, "is_group_chat", return_value=True):
                with patch.object(
                    service, "can_access_knowledge_base", return_value=True
                ):
                    with patch.object(
                        service,
                        "get_knowledge_base_by_name",
                        return_value=mock_knowledge_base,
                    ):
                        with patch.object(service, "get_user", return_value=mock_user):
                            with patch(
                                "app.services.knowledge.task_knowledge_base_service.task_member_service"
                            ) as mock_member:
                                mock_member.is_member.return_value = True
                                with patch(
                                    "app.stores.tasks.sqlalchemy_task_store.flag_modified"
                                ):
                                    with patch(
                                        "app.services.knowledge.task_knowledge_base_service.KnowledgeService"
                                    ) as mock_ks:
                                        mock_ks.get_document_count.return_value = 5

                                        service.bind_knowledge_base(
                                            db=mock_db,
                                            task_id=100,
                                            kb_name="Test KB",
                                            kb_namespace="default",
                                            user_id=1,
                                        )

                                        # Verify the new ref includes ID
                                        kb_refs = mock_task.json["spec"][
                                            "knowledgeBaseRefs"
                                        ]
                                        assert len(kb_refs) == 1
                                        assert kb_refs[0]["id"] == 10
                                        assert kb_refs[0]["name"] == "Test KB"
                                        # Note: namespace is no longer stored in new refs
                                        assert "namespace" not in kb_refs[0]

    def test_duplicate_check_with_id(self, service, mock_db, mock_knowledge_base):
        """Test that duplicate detection works with ID"""
        mock_task = Mock(spec=TaskResource)
        mock_task.id = 100
        mock_task.json = {
            "spec": {
                "title": "Test Task",
                "is_group_chat": True,
                # Already has KB bound by ID
                "knowledgeBaseRefs": [
                    {"id": 10, "name": "Old Name", "namespace": "default"}
                ],
            }
        }

        with patch(
            "app.services.knowledge.task_knowledge_base_service.task_store.get_by_id_for_update",
            return_value=mock_task,
        ):
            with patch.object(service, "is_group_chat", return_value=True):
                with patch.object(
                    service, "can_access_knowledge_base", return_value=True
                ):
                    with patch.object(
                        service,
                        "get_knowledge_base_by_name",
                        return_value=mock_knowledge_base,
                    ):
                        with patch(
                            "app.services.knowledge.task_knowledge_base_service.task_member_service"
                        ) as mock_member:
                            mock_member.is_member.return_value = True

                            # Should raise error because KB with ID=10 is already bound
                            # even though name is different
                            from fastapi import HTTPException

                            with pytest.raises(HTTPException) as exc_info:
                                service.bind_knowledge_base(
                                    db=mock_db,
                                    task_id=100,
                                    kb_name="Test KB",  # Different name
                                    kb_namespace="default",
                                    user_id=1,
                                )

                            assert exc_info.value.status_code == 400
                            assert "already bound" in exc_info.value.detail


@pytest.mark.unit
def test_task_binding_projection_includes_scope_only_and_whole_wins_duplicates():
    projection = project_task_knowledge_bindings(
        {
            "knowledgeBaseRefs": [{"id": 1, "name": "Whole"}],
            "knowledgeBaseScopes": [
                {
                    "id": 1,
                    "name": "Scoped duplicate",
                    "scopeRestricted": True,
                    "explicitDocumentIds": [10],
                },
                {
                    "id": 2,
                    "name": "Scoped only",
                    "scopeRestricted": True,
                    "folderIds": [20],
                    "explicitDocumentIds": [21],
                    "includeSubfolders": False,
                },
            ],
        }
    )

    assert [ref["id"] for ref in projection] == [1, 2]
    assert projection[0]["scope_restricted"] is False
    assert projection[1]["scope_restricted"] is True
    assert projection[1]["folder_ids"] == [20]
    assert projection[1]["document_ids"] == [21]
    assert projection[1]["include_subfolders"] is False


@pytest.mark.unit
def test_task_binding_projection_preserves_legacy_scoped_ref():
    projection = project_task_knowledge_bindings(
        {
            "knowledgeBaseRefs": [
                {
                    "id": 7,
                    "name": "Scoped legacy",
                    "scopeRestricted": True,
                    "explicitDocumentIds": [100],
                }
            ]
        }
    )

    assert projection == [
        {
            "id": 7,
            "name": "Scoped legacy",
            "scopeRestricted": True,
            "explicitDocumentIds": [100],
            "_binding_source": "scope",
            "scope_restricted": True,
            "document_ids": [100],
            "folder_ids": [],
            "include_subfolders": True,
        }
    ]


@pytest.mark.unit
def test_unbind_by_id_clears_whole_and_scoped_fields() -> None:
    service = TaskKnowledgeBaseService()
    db = MagicMock(spec=Session)
    task = Mock(spec=TaskResource)
    task.id = 100
    task.json = {
        "spec": {
            "knowledgeBaseRefs": [
                {"id": 7, "name": "Same"},
                {"id": 8, "name": "Keep"},
            ],
            "knowledgeBaseScopes": [
                {"id": 7, "name": "Same", "scopeRestricted": True},
                {"id": 9, "name": "Keep scope", "scopeRestricted": True},
            ],
        }
    }
    with (
        patch(
            "app.services.knowledge.task_knowledge_base_service."
            "task_member_service.is_member",
            return_value=True,
        ),
        patch(
            "app.services.knowledge.task_knowledge_base_service."
            "task_store.get_by_id_for_update",
            return_value=task,
        ),
        patch(
            "app.services.knowledge.task_knowledge_base_service."
            "task_store.update_json"
        ) as update_json,
    ):
        service.unbind_knowledge_base(
            db,
            task_id=100,
            kb_name="Same",
            kb_namespace="default",
            user_id=1,
            kb_id=7,
        )

    payload = update_json.call_args.kwargs["payload"]
    assert [ref["id"] for ref in payload["spec"]["knowledgeBaseRefs"]] == [8]
    assert [ref["id"] for ref in payload["spec"]["knowledgeBaseScopes"]] == [9]


class TestKBRefAutoMigration:
    """Test automatic migration of legacy name-only refs to include ID"""

    @pytest.fixture
    def mock_db(self):
        """Create a mock database session"""
        return Mock(spec=Session)

    @pytest.fixture
    def service(self):
        """Create TaskKnowledgeBaseService instance"""
        return TaskKnowledgeBaseService()

    def test_auto_migration_on_get_bound_kb_ids(self, service, mock_db):
        """Test that legacy refs are migrated when accessed via get_bound_knowledge_base_ids"""
        mock_task = Mock(spec=TaskResource)
        mock_task.id = 100
        mock_task.json = {
            "spec": {
                # Legacy ref without ID
                "knowledgeBaseRefs": [{"name": "Test KB", "namespace": "default"}]
            }
        }

        mock_kb = Mock(spec=Kind)
        mock_kb.id = 10
        mock_kb.json = {"spec": {"name": "Test KB"}}

        mock_query = MagicMock()
        mock_db.query.return_value = mock_query
        mock_query.filter.return_value = mock_query

        with patch.object(service, "get_task", return_value=mock_task):
            # Mock resolve_kb_refs_batch to return KB with needs_migration=True
            with patch.object(
                service,
                "resolve_kb_refs_batch",
                return_value=([(0, mock_kb, True)], []),
            ):
                with patch.object(service, "_batch_migrate_kb_refs") as mock_migrate:
                    result = service.get_bound_knowledge_base_ids(mock_db, task_id=100)

                    assert result == [10]
                    # Should call batch migration with the legacy ref
                    mock_migrate.assert_called_once()
                    call_args = mock_migrate.call_args
                    assert call_args[0][0] == mock_db  # db
                    assert call_args[0][1] == mock_task  # task
                    assert call_args[0][2] == [(0, 10)]  # refs_to_migrate

    def test_no_migration_when_id_exists(self, service, mock_db):
        """Test that refs with ID are not migrated"""
        mock_task = Mock(spec=TaskResource)
        mock_task.id = 100
        mock_task.json = {
            "spec": {
                # Ref with ID (already migrated)
                "knowledgeBaseRefs": [
                    {"id": 10, "name": "Test KB", "namespace": "default"}
                ]
            }
        }

        mock_kb = Mock(spec=Kind)
        mock_kb.id = 10

        with patch.object(service, "get_task", return_value=mock_task):
            # Mock resolve_kb_refs_batch to return KB with needs_migration=False
            with patch.object(
                service,
                "resolve_kb_refs_batch",
                return_value=([(0, mock_kb, False)], []),
            ):
                with patch.object(service, "_batch_migrate_kb_refs") as mock_migrate:
                    result = service.get_bound_knowledge_base_ids(mock_db, task_id=100)

                    assert result == [10]
                    # Should NOT call batch migration
                    mock_migrate.assert_not_called()

    def test_batch_migrate_updates_refs(self, service, mock_db):
        """Test that _batch_migrate_kb_refs correctly updates refs"""
        mock_task = Mock(spec=TaskResource)
        mock_task.id = 100
        mock_task.json = {
            "spec": {
                "knowledgeBaseRefs": [
                    {"name": "KB1", "namespace": "default"},
                    {"name": "KB2", "namespace": "team1"},
                ]
            }
        }

        refs_to_migrate = [(0, 10), (1, 20)]

        with patch("app.stores.tasks.sqlalchemy_task_store.flag_modified") as mock_flag:
            service._batch_migrate_kb_refs(mock_db, mock_task, refs_to_migrate)

            # Verify refs were updated with IDs
            kb_refs = mock_task.json["spec"]["knowledgeBaseRefs"]
            assert kb_refs[0]["id"] == 10
            assert kb_refs[1]["id"] == 20
            # Verify flag_modified was called
            mock_flag.assert_called_once_with(mock_task, "json")
            # Verify commit was called
            mock_db.commit.assert_called_once()


@pytest.mark.unit
class TestContextsIdBasedLookup:
    """Test _get_bound_knowledge_base_ids in contexts.py delegates to service layer"""

    @pytest.fixture
    def mock_db(self):
        """Create a mock database session"""
        return Mock(spec=Session)

    def test_get_bound_kb_ids_delegates_to_service(self, mock_db):
        """Test that _get_bound_knowledge_base_ids delegates to service layer"""
        from app.services.chat.preprocessing.contexts import (
            _get_bound_knowledge_base_ids,
        )

        with patch(
            "app.services.knowledge.task_knowledge_base_service.task_knowledge_base_service"
        ) as mock_service:
            mock_service.get_bound_knowledge_base_ids.return_value = [10, 20, 30]

            result = _get_bound_knowledge_base_ids(mock_db, task_id=100, user_id=1)

            # Should delegate to service layer
            mock_service.get_bound_knowledge_base_ids.assert_called_once_with(
                mock_db, 100, user_id=1
            )
            assert result == [10, 20, 30]

    def test_get_bound_kb_ids_handles_service_exception(self, mock_db):
        """Test that exceptions from service are caught and empty list returned"""
        from app.services.chat.preprocessing.contexts import (
            _get_bound_knowledge_base_ids,
        )

        with patch(
            "app.services.knowledge.task_knowledge_base_service.task_knowledge_base_service"
        ) as mock_service:
            mock_service.get_bound_knowledge_base_ids.side_effect = Exception(
                "DB connection failed"
            )

            result = _get_bound_knowledge_base_ids(mock_db, task_id=100, user_id=1)

            # Should return empty list on exception
            assert result == []

    def test_get_bound_kb_ids_returns_empty_for_no_kbs(self, mock_db):
        """Test that empty list is returned when no KBs are bound"""
        from app.services.chat.preprocessing.contexts import (
            _get_bound_knowledge_base_ids,
        )

        with patch(
            "app.services.knowledge.task_knowledge_base_service.task_knowledge_base_service"
        ) as mock_service:
            mock_service.get_bound_knowledge_base_ids.return_value = []

            result = _get_bound_knowledge_base_ids(mock_db, task_id=100, user_id=1)

            assert result == []
