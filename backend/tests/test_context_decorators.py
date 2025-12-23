# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Tests for WebSocket context decorators.
"""

from unittest.mock import AsyncMock, Mock, patch

import pytest
from pydantic import BaseModel, ValidationError

from app.api.ws.context_decorators import (
    auto_payload_validation,
    auto_task_context,
)


# Test models
class TaskPayload(BaseModel):
    task_id: int


class SubtaskPayload(BaseModel):
    subtask_id: int


class MixedPayload(BaseModel):
    task_id: int
    subtask_id: int | None = None


class OptionalTaskPayload(BaseModel):
    task_id: int | None = None
    message: str


class TestAutoTaskContextDecorator:
    """Test suite for @auto_task_context decorator."""

    @pytest.mark.asyncio
    async def test_validates_payload_successfully(self):
        """Test that decorator validates valid payload."""

        @auto_task_context(TaskPayload)
        async def handler(self, sid: str, data):
            return {"success": True, "task_id": data.task_id}

        mock_self = Mock()
        result = await handler(mock_self, "sid123", {"task_id": 123})

        assert result["success"] is True
        assert result["task_id"] == 123

    @pytest.mark.asyncio
    async def test_returns_error_for_invalid_payload(self):
        """Test that decorator returns error for invalid payload."""

        @auto_task_context(TaskPayload)
        async def handler(self, sid: str, data):
            return {"success": True}

        mock_self = Mock()
        result = await handler(mock_self, "sid123", {"invalid": "data"})

        assert "error" in result
        assert "Invalid payload" in result["error"]

    @pytest.mark.asyncio
    async def test_sets_task_context(self):
        """Test that decorator sets task context."""

        @auto_task_context(TaskPayload, task_id_field="task_id")
        async def handler(self, sid: str, data):
            return {"success": True}

        mock_self = Mock()

        with patch("app.api.ws.context_decorators.set_task_context") as mock_set:
            await handler(mock_self, "sid123", {"task_id": 456})

            # Verify set_task_context was called with correct value
            mock_set.assert_called_once_with(task_id=456)

    @pytest.mark.asyncio
    async def test_sets_subtask_context(self):
        """Test that decorator sets subtask context only."""

        @auto_task_context(
            SubtaskPayload, task_id_field=None, subtask_id_field="subtask_id"
        )
        async def handler(self, sid: str, data):
            return {"success": True}

        mock_self = Mock()

        with patch("app.api.ws.context_decorators.set_task_context") as mock_set:
            await handler(mock_self, "sid123", {"subtask_id": 789})

            # Should only set subtask_id
            mock_set.assert_called_once_with(subtask_id=789)

    @pytest.mark.asyncio
    async def test_sets_both_contexts(self):
        """Test that decorator sets both task and subtask contexts."""

        @auto_task_context(
            MixedPayload, task_id_field="task_id", subtask_id_field="subtask_id"
        )
        async def handler(self, sid: str, data):
            return {"success": True}

        mock_self = Mock()

        with patch("app.api.ws.context_decorators.set_task_context") as mock_set:
            await handler(mock_self, "sid123", {"task_id": 111, "subtask_id": 222})

            # Should set both values
            mock_set.assert_called_once_with(task_id=111, subtask_id=222)

    @pytest.mark.asyncio
    async def test_handles_none_task_id(self):
        """Test that decorator skips None task_id."""

        @auto_task_context(OptionalTaskPayload, task_id_field="task_id")
        async def handler(self, sid: str, data):
            return {"success": True}

        mock_self = Mock()

        with patch("app.api.ws.context_decorators.set_task_context") as mock_set:
            # task_id is None
            await handler(mock_self, "sid123", {"task_id": None, "message": "hello"})

            # set_task_context should not be called (no non-None values)
            assert not mock_set.called

    @pytest.mark.asyncio
    async def test_handles_none_subtask_id(self):
        """Test that decorator skips None subtask_id but sets task_id."""

        @auto_task_context(
            MixedPayload, task_id_field="task_id", subtask_id_field="subtask_id"
        )
        async def handler(self, sid: str, data):
            return {"success": True}

        mock_self = Mock()

        with patch("app.api.ws.context_decorators.set_task_context") as mock_set:
            # subtask_id is None
            await handler(mock_self, "sid123", {"task_id": 999, "subtask_id": None})

            # Should only set task_id (skip None subtask_id)
            mock_set.assert_called_once_with(task_id=999)

    @pytest.mark.asyncio
    async def test_passes_validated_payload_to_function(self):
        """Test that decorator passes validated Pydantic object."""

        @auto_task_context(TaskPayload)
        async def handler(self, sid: str, data):
            # data should be the validated TaskPayload object
            assert isinstance(data, TaskPayload)
            assert data.task_id == 555
            return {"success": True}

        mock_self = Mock()
        result = await handler(mock_self, "sid123", {"task_id": 555})

        assert result["success"] is True

    @pytest.mark.asyncio
    async def test_gracefully_handles_set_context_errors(self):
        """Test that decorator doesn't crash if set_task_context fails."""

        @auto_task_context(TaskPayload)
        async def handler(self, sid: str, data):
            return {"success": True}

        mock_self = Mock()

        with patch("app.api.ws.context_decorators.set_task_context") as mock_set:
            mock_set.side_effect = Exception("Context error")

            # Should not raise exception
            result = await handler(mock_self, "sid123", {"task_id": 123})
            assert result["success"] is True

    @pytest.mark.asyncio
    async def test_logs_validation_errors(self):
        """Test that decorator logs validation errors."""

        @auto_task_context(TaskPayload)
        async def handler(self, sid: str, data):
            return {"success": True}

        mock_self = Mock()

        with patch("app.api.ws.context_decorators.logger") as mock_logger:
            result = await handler(mock_self, "sid123", {"invalid": "data"})

            # Should log error
            assert mock_logger.error.called
            assert "error" in result

    @pytest.mark.asyncio
    async def test_default_task_id_field(self):
        """Test that task_id is the default field name."""

        @auto_task_context(TaskPayload)  # No explicit task_id_field
        async def handler(self, sid: str, data):
            return {"success": True}

        mock_self = Mock()

        with patch("app.api.ws.context_decorators.set_task_context") as mock_set:
            await handler(mock_self, "sid123", {"task_id": 777})

            # Default should be "task_id"
            mock_set.assert_called_once_with(task_id=777)


class TestAutoPayloadValidationDecorator:
    """Test suite for @auto_payload_validation decorator."""

    @pytest.mark.asyncio
    async def test_validates_payload_successfully(self):
        """Test that decorator validates valid payload."""

        @auto_payload_validation(TaskPayload)
        async def handler(self, sid: str, data):
            return {"success": True, "task_id": data.task_id}

        mock_self = Mock()
        result = await handler(mock_self, "sid123", {"task_id": 123})

        assert result["success"] is True
        assert result["task_id"] == 123

    @pytest.mark.asyncio
    async def test_returns_error_for_invalid_payload(self):
        """Test that decorator returns error for invalid payload."""

        @auto_payload_validation(TaskPayload)
        async def handler(self, sid: str, data):
            return {"success": True}

        mock_self = Mock()
        result = await handler(mock_self, "sid123", {"invalid": "data"})

        assert "error" in result
        assert "Invalid payload" in result["error"]

    @pytest.mark.asyncio
    async def test_does_not_set_context(self):
        """Test that decorator does NOT set task context."""

        @auto_payload_validation(TaskPayload)
        async def handler(self, sid: str, data):
            return {"success": True}

        mock_self = Mock()

        with patch("app.api.ws.context_decorators.set_task_context") as mock_set:
            await handler(mock_self, "sid123", {"task_id": 456})

            # Should NOT call set_task_context
            assert not mock_set.called

    @pytest.mark.asyncio
    async def test_passes_validated_payload(self):
        """Test that decorator passes validated Pydantic object."""

        @auto_payload_validation(MixedPayload)
        async def handler(self, sid: str, data):
            assert isinstance(data, MixedPayload)
            assert data.task_id == 888
            assert data.subtask_id == 999
            return {"success": True}

        mock_self = Mock()
        result = await handler(mock_self, "sid123", {"task_id": 888, "subtask_id": 999})

        assert result["success"] is True


class TestDecoratorIntegration:
    """Integration tests for decorator combinations."""

    @pytest.mark.asyncio
    async def test_multiple_decorators_work_together(self):
        """Test that decorators can be stacked (though not recommended)."""

        # Note: This is just for testing, not a recommended pattern
        @auto_task_context(TaskPayload)
        async def handler(self, sid: str, data):
            return {"success": True, "task_id": data.task_id}

        mock_self = Mock()

        with patch("app.api.ws.context_decorators.set_task_context") as mock_set:
            result = await handler(mock_self, "sid123", {"task_id": 321})

            assert result["success"] is True
            assert result["task_id"] == 321
            assert mock_set.called

    @pytest.mark.asyncio
    async def test_real_world_scenario(self):
        """Test a realistic event handler scenario."""

        class ChatSendPayload(BaseModel):
            task_id: int | None = None
            team_id: int
            message: str

        @auto_task_context(ChatSendPayload, task_id_field="task_id")
        async def on_chat_send(self, sid: str, data):
            # Simulate real handler logic
            payload = data
            return {
                "success": True,
                "task_id": payload.task_id,
                "team_id": payload.team_id,
                "message_length": len(payload.message),
            }

        mock_self = Mock()

        with patch("app.api.ws.context_decorators.set_task_context") as mock_set:
            # With task_id
            result = await on_chat_send(
                mock_self,
                "sid123",
                {"task_id": 100, "team_id": 200, "message": "Hello world"},
            )

            assert result["success"] is True
            assert result["task_id"] == 100
            assert result["team_id"] == 200
            assert result["message_length"] == 11
            mock_set.assert_called_once_with(task_id=100)

            mock_set.reset_mock()

            # Without task_id (None)
            result = await on_chat_send(
                mock_self, "sid456", {"task_id": None, "team_id": 300, "message": "Hi"}
            )

            assert result["success"] is True
            assert result["task_id"] is None
            # set_task_context should not be called when task_id is None
            assert not mock_set.called
