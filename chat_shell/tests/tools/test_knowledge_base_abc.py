# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for KnowledgeBaseToolABC abstract base class."""

from typing import Any, Dict, List, Optional
from unittest.mock import Mock

import pytest

from chat_shell.tools.builtin.knowledge_base_abc import KnowledgeBaseToolABC


class ConcreteKnowledgeBaseTool(KnowledgeBaseToolABC):
    """Concrete implementation for testing ABC."""

    def __init__(
        self,
        user_subtask_id: Optional[int] = None,
        knowledge_base_ids: Optional[List[int]] = None,
        user_id: int = 0,
        db_session: Optional[Any] = None,
    ):
        self.user_subtask_id = user_subtask_id
        self.knowledge_base_ids = knowledge_base_ids or []
        self.user_id = user_id
        self.db_session = db_session
        self._persist_calls: List[tuple] = []

    async def _persist_result(
        self,
        kb_id: int,
        result_data: Dict[str, Any],
    ) -> None:
        """Record persist calls for testing."""
        self._persist_calls.append((kb_id, result_data))


class IncompleteKnowledgeBaseTool(KnowledgeBaseToolABC):
    """Incomplete implementation that doesn't implement _persist_result."""

    def __init__(self):
        self.user_subtask_id = None
        self.knowledge_base_ids = []
        self.user_id = 0
        self.db_session = None


class TestKnowledgeBaseToolABC:
    """Test KnowledgeBaseToolABC abstract base class."""

    def test_concrete_implementation_can_be_instantiated(self):
        """Test that concrete implementation can be instantiated."""
        tool = ConcreteKnowledgeBaseTool(
            user_subtask_id=100,
            knowledge_base_ids=[1, 2, 3],
            user_id=1,
        )

        assert tool.user_subtask_id == 100
        assert tool.knowledge_base_ids == [1, 2, 3]
        assert tool.user_id == 1

    def test_incomplete_implementation_raises_error(self):
        """Test that incomplete implementation raises TypeError."""
        with pytest.raises(TypeError) as exc_info:
            # Attempting to instantiate without implementing _persist_result
            # should raise TypeError
            IncompleteKnowledgeBaseTool()

        assert (
            "abstract method" in str(exc_info.value).lower()
            or "abstract" in str(exc_info.value).lower()
        )

    def test_should_persist_returns_true_when_both_set(self):
        """Test _should_persist returns True when user_subtask_id and knowledge_base_ids are set."""
        tool = ConcreteKnowledgeBaseTool(
            user_subtask_id=100,
            knowledge_base_ids=[1, 2],
        )

        assert tool._should_persist() is True

    def test_should_persist_returns_false_when_user_subtask_id_not_set(self):
        """Test _should_persist returns False when user_subtask_id is None."""
        tool = ConcreteKnowledgeBaseTool(
            user_subtask_id=None,
            knowledge_base_ids=[1, 2],
        )

        assert tool._should_persist() is False

    def test_should_persist_returns_false_when_knowledge_base_ids_empty(self):
        """Test _should_persist returns False when knowledge_base_ids is empty."""
        tool = ConcreteKnowledgeBaseTool(
            user_subtask_id=100,
            knowledge_base_ids=[],
        )

        assert tool._should_persist() is False

    def test_should_persist_returns_false_when_both_not_set(self):
        """Test _should_persist returns False when both are not set."""
        tool = ConcreteKnowledgeBaseTool()

        assert tool._should_persist() is False

    @pytest.mark.asyncio
    async def test_persist_result_is_called(self):
        """Test _persist_result method can be called."""
        tool = ConcreteKnowledgeBaseTool(
            user_subtask_id=100,
            knowledge_base_ids=[1],
            user_id=1,
        )

        result_data = {"key": "value"}
        await tool._persist_result(kb_id=1, result_data=result_data)

        assert len(tool._persist_calls) == 1
        assert tool._persist_calls[0] == (1, result_data)

    @pytest.mark.asyncio
    async def test_persist_result_can_be_called_multiple_times(self):
        """Test _persist_result can be called multiple times."""
        tool = ConcreteKnowledgeBaseTool(
            user_subtask_id=100,
            knowledge_base_ids=[1, 2],
            user_id=1,
        )

        await tool._persist_result(kb_id=1, result_data={"data": "for_kb_1"})
        await tool._persist_result(kb_id=2, result_data={"data": "for_kb_2"})

        assert len(tool._persist_calls) == 2
        assert tool._persist_calls[0][0] == 1
        assert tool._persist_calls[1][0] == 2
