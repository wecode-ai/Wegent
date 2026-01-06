# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Tests for subtask knowledge base sync to task level functionality.

This module tests the following features:
1. sync_subtask_kb_to_task method in TaskKnowledgeBaseService
2. Knowledge base priority logic (subtask > task level)
3. Deduplication and limit enforcement
"""

from unittest.mock import MagicMock, Mock, patch

import pytest
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.subtask_context import SubtaskContext
from app.models.task import TaskResource
from app.services.task_knowledge_base_service import TaskKnowledgeBaseService


@pytest.mark.unit
class TestSyncSubtaskKBToTask:
    """Test sync_subtask_kb_to_task method in TaskKnowledgeBaseService"""

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

    @pytest.fixture
    def mock_task(self):
        """Create a mock task without any KB refs"""
        task = Mock(spec=TaskResource)
        task.id = 100
        task.kind = "Task"
        task.is_active = True
        task.json = {
            "spec": {
                "title": "Test Task",
                "is_group_chat": False,
                "knowledgeBaseRefs": [],
            }
        }
        return task

    def test_sync_kb_to_task_success(
        self, service, mock_db, mock_knowledge_base, mock_task
    ):
        """Test successful sync of KB from subtask to task level"""
        # Setup mocks
        mock_query = MagicMock()
        mock_db.query.return_value = mock_query
        mock_query.filter.return_value = mock_query

        # Query returns KB only (task and user are now passed as parameters)
        mock_query.first.return_value = mock_knowledge_base

        # Mock can_access_knowledge_base to return True
        with patch.object(
            service, "can_access_knowledge_base", return_value=True
        ) as mock_access:
            # Mock flag_modified to avoid SQLAlchemy state error
            with patch(
                "app.services.task_knowledge_base_service.flag_modified"
            ) as mock_flag:
                result = service.sync_subtask_kb_to_task(
                    db=mock_db,
                    task=mock_task,
                    knowledge_id=10,
                    user_id=1,
                    user_name="testuser",
                )

                assert result is True
                mock_access.assert_called_once_with(mock_db, 1, "Test KB", "default")
                mock_db.commit.assert_called_once()
                mock_flag.assert_called_once()

                # Verify KB ref was added to task
                kb_refs = mock_task.json["spec"]["knowledgeBaseRefs"]
                assert len(kb_refs) == 1
                assert kb_refs[0]["name"] == "Test KB"
                assert kb_refs[0]["namespace"] == "default"
                assert kb_refs[0]["boundBy"] == "testuser"

    def test_sync_kb_to_task_already_bound(self, service, mock_db, mock_knowledge_base):
        """Test that duplicate KB is not added (deduplication)"""
        # Task already has the KB bound
        mock_task = Mock(spec=TaskResource)
        mock_task.id = 100
        mock_task.json = {
            "spec": {
                "knowledgeBaseRefs": [
                    {"name": "Test KB", "namespace": "default", "boundBy": "otheruser"}
                ]
            }
        }

        mock_query = MagicMock()
        mock_db.query.return_value = mock_query
        mock_query.filter.return_value = mock_query
        mock_query.first.return_value = mock_knowledge_base

        with patch.object(service, "can_access_knowledge_base", return_value=True):
            result = service.sync_subtask_kb_to_task(
                db=mock_db,
                task=mock_task,
                knowledge_id=10,
                user_id=1,
                user_name="testuser",
            )

            # Should return False (already bound, not synced again)
            assert result is False
            mock_db.commit.assert_not_called()

    def test_sync_kb_to_task_limit_reached(self, service, mock_db, mock_knowledge_base):
        """Test that sync is skipped when KB limit (10) is reached"""
        # Task already has 10 KBs bound
        mock_task = Mock(spec=TaskResource)
        mock_task.id = 100
        mock_task.json = {
            "spec": {
                "knowledgeBaseRefs": [
                    {"name": f"KB {i}", "namespace": "default"} for i in range(10)
                ]
            }
        }

        mock_query = MagicMock()
        mock_db.query.return_value = mock_query
        mock_query.filter.return_value = mock_query
        mock_query.first.return_value = mock_knowledge_base

        with patch.object(service, "can_access_knowledge_base", return_value=True):
            result = service.sync_subtask_kb_to_task(
                db=mock_db,
                task=mock_task,
                knowledge_id=10,
                user_id=1,
                user_name="testuser",
            )

            # Should return False (limit reached)
            assert result is False
            mock_db.commit.assert_not_called()

    def test_sync_kb_to_task_no_access(
        self, service, mock_db, mock_knowledge_base, mock_task
    ):
        """Test that sync is skipped when user has no access to KB"""
        mock_query = MagicMock()
        mock_db.query.return_value = mock_query
        mock_query.filter.return_value = mock_query
        mock_query.first.return_value = mock_knowledge_base

        with patch.object(service, "can_access_knowledge_base", return_value=False):
            result = service.sync_subtask_kb_to_task(
                db=mock_db,
                task=mock_task,
                knowledge_id=10,
                user_id=1,
                user_name="testuser",
            )

            # Should return False (no access)
            assert result is False
            mock_db.commit.assert_not_called()

    def test_sync_kb_to_task_kb_not_found(self, service, mock_db, mock_task):
        """Test that sync is skipped when KB is not found"""
        mock_query = MagicMock()
        mock_db.query.return_value = mock_query
        mock_query.filter.return_value = mock_query
        mock_query.first.return_value = None

        result = service.sync_subtask_kb_to_task(
            db=mock_db,
            task=mock_task,
            knowledge_id=999,
            user_id=1,
            user_name="testuser",
        )

        # Should return False (KB not found)
        assert result is False
        mock_db.commit.assert_not_called()


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

        # Mock task-level KB (should be ignored when subtask has KB)
        with patch(
            "app.services.chat.preprocessing.contexts._get_bound_knowledge_base_ids"
        ) as mock_get_bound:
            mock_get_bound.return_value = [20, 30]  # Task-level KBs

            with patch(
                "app.chat_shell.tools.builtin.KnowledgeBaseTool"
            ) as mock_kb_tool:
                mock_kb_tool.return_value = Mock()

                _tools, _prompt = _prepare_kb_tools_from_contexts(
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

            with patch(
                "app.chat_shell.tools.builtin.KnowledgeBaseTool"
            ) as mock_kb_tool:
                mock_kb_tool.return_value = Mock()

                _tools, _prompt = _prepare_kb_tools_from_contexts(
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

    def test_no_kb_when_both_empty(self, mock_db):
        """Test that no KB tool is created when both levels have no KB"""
        from app.services.chat.preprocessing.contexts import (
            _prepare_kb_tools_from_contexts,
        )

        with patch(
            "app.services.chat.preprocessing.contexts._get_bound_knowledge_base_ids"
        ) as mock_get_bound:
            mock_get_bound.return_value = []  # No task-level KBs

            with patch(
                "app.services.chat.preprocessing.contexts._build_historical_kb_meta_prompt"
            ) as mock_history:
                mock_history.return_value = ""

                tools, prompt = _prepare_kb_tools_from_contexts(
                    kb_contexts=[],  # No subtask KB
                    user_id=1,
                    db=mock_db,
                    base_system_prompt="Base prompt",
                    task_id=100,
                    user_subtask_id=1,
                )

                # Should return empty tools
                assert tools == []
                assert prompt == "Base prompt"


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

        result = _get_bound_knowledge_base_ids(mock_db, task_id=100)

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

        result = _get_bound_knowledge_base_ids(mock_db, task_id=100)

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

        result = _get_bound_knowledge_base_ids(mock_db, task_id=999)

        assert result == []
