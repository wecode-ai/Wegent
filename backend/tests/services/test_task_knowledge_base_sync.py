# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Tests for subtask knowledge base sync to task level functionality.

This module tests the following features:
1. sync_subtask_kb_to_task method in TaskKnowledgeBaseService
2. Knowledge base priority logic (subtask > task level)
3. Deduplication and limit enforcement
4. ID-based lookup and automatic migration from name-only refs
"""

from unittest.mock import MagicMock, Mock, patch

import pytest
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.subtask_context import SubtaskContext
from app.models.task import TaskResource
from app.services.knowledge import TaskKnowledgeBaseService


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
                "app.services.knowledge.task_knowledge_base_service.flag_modified"
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

            with patch("chat_shell.tools.builtin.KnowledgeBaseTool") as mock_kb_tool:
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

            with patch("chat_shell.tools.builtin.KnowledgeBaseTool") as mock_kb_tool:
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

        with patch.object(service, "get_task", return_value=mock_task):
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
                                    "app.services.knowledge.task_knowledge_base_service.flag_modified"
                                ):
                                    with patch(
                                        "app.services.knowledge.task_knowledge_base_service.KnowledgeService"
                                    ) as mock_ks:
                                        mock_ks.get_active_document_count.return_value = (
                                            5
                                        )

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
                                        assert kb_refs[0]["namespace"] == "default"

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

        with patch.object(service, "get_task", return_value=mock_task):
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

    def test_sync_kb_includes_id(self, service, mock_db, mock_knowledge_base):
        """Test that sync_subtask_kb_to_task includes ID in new refs"""
        mock_task = Mock(spec=TaskResource)
        mock_task.id = 100
        mock_task.json = {
            "spec": {
                "title": "Test Task",
                "knowledgeBaseRefs": [],
            }
        }

        mock_query = MagicMock()
        mock_db.query.return_value = mock_query
        mock_query.filter.return_value = mock_query
        mock_query.first.return_value = mock_knowledge_base

        with patch.object(service, "can_access_knowledge_base", return_value=True):
            with patch(
                "app.services.knowledge.task_knowledge_base_service.flag_modified"
            ):
                result = service.sync_subtask_kb_to_task(
                    db=mock_db,
                    task=mock_task,
                    knowledge_id=10,
                    user_id=1,
                    user_name="testuser",
                )

                assert result is True
                kb_refs = mock_task.json["spec"]["knowledgeBaseRefs"]
                assert len(kb_refs) == 1
                # Verify ID is included
                assert kb_refs[0]["id"] == 10
                assert kb_refs[0]["name"] == "Test KB"

    def test_sync_kb_dedup_by_id(self, service, mock_db, mock_knowledge_base):
        """Test that sync deduplication works with ID"""
        mock_task = Mock(spec=TaskResource)
        mock_task.id = 100
        mock_task.json = {
            "spec": {
                "knowledgeBaseRefs": [
                    # Already bound by ID (different name)
                    {"id": 10, "name": "Old Name", "namespace": "default"}
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

            # Should return False (already bound by ID)
            assert result is False
            mock_db.commit.assert_not_called()


@pytest.mark.unit
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

        with patch(
            "app.services.knowledge.task_knowledge_base_service.flag_modified"
        ) as mock_flag:
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

            result = _get_bound_knowledge_base_ids(mock_db, task_id=100)

            # Should delegate to service layer
            mock_service.get_bound_knowledge_base_ids.assert_called_once_with(
                mock_db, 100
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

            result = _get_bound_knowledge_base_ids(mock_db, task_id=100)

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

            result = _get_bound_knowledge_base_ids(mock_db, task_id=100)

            assert result == []
