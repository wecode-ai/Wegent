# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Tests for WebSocket event tracing decorators.
"""

from unittest.mock import AsyncMock, Mock, call, patch

import pytest

from app.api.ws.decorators import (
    _safe_set_attribute,
    _set_event_data_attributes,
    trace_websocket_event,
)


class TestTraceWebSocketEventDecorator:
    """Test suite for @trace_websocket_event decorator."""

    @pytest.mark.asyncio
    async def test_decorator_creates_span_successfully(self):
        """Test that decorator creates OpenTelemetry span for events."""

        class MockNamespace:
            namespace = "/test"

            async def get_session(self, sid):
                return {"user_id": 123, "user_name": "testuser"}

            @trace_websocket_event()
            async def trigger_event(self, event, sid, *args):
                return "success"

        ns = MockNamespace()

        with patch("app.api.ws.decorators.settings.OTEL_ENABLED", True):
            with patch("app.api.ws.decorators.is_telemetry_enabled", return_value=True):
                with patch("app.api.ws.decorators.trace.get_tracer") as mock_tracer:
                    mock_span = Mock()
                    mock_span.is_recording.return_value = True
                    mock_context = Mock()
                    mock_context.__enter__ = Mock(return_value=mock_span)
                    mock_context.__exit__ = Mock(return_value=None)
                    mock_tracer.return_value.start_as_current_span.return_value = (
                        mock_context
                    )

                    result = await ns.trigger_event("test:event", "sid123")

                    assert result == "success"
                    # Verify tracer was called
                    mock_tracer.assert_called_once()
                    # Verify span was created
                    mock_tracer.return_value.start_as_current_span.assert_called_once()

    @pytest.mark.asyncio
    async def test_decorator_sets_basic_attributes(self):
        """Test that decorator sets basic WebSocket attributes."""

        class MockNamespace:
            namespace = "/chat"

            async def get_session(self, sid):
                return {"user_id": 123, "user_name": "testuser"}

            @trace_websocket_event()
            async def trigger_event(self, event, sid, *args):
                return "success"

        ns = MockNamespace()

        with patch("app.api.ws.decorators.settings.OTEL_ENABLED", True):
            with patch("app.api.ws.decorators.is_telemetry_enabled", return_value=True):
                with patch("app.api.ws.decorators.trace.get_tracer") as mock_tracer:
                    mock_span = Mock()
                    mock_span.is_recording.return_value = True
                    mock_context = Mock()
                    mock_context.__enter__ = Mock(return_value=mock_span)
                    mock_context.__exit__ = Mock(return_value=None)
                    mock_tracer.return_value.start_as_current_span.return_value = (
                        mock_context
                    )

                    await ns.trigger_event("chat:send", "sid456")

                    # Verify basic attributes were set
                    calls = mock_span.set_attribute.call_args_list
                    attribute_dict = {call[0][0]: call[0][1] for call in calls}

                    assert attribute_dict["websocket.event"] == "chat:send"
                    assert attribute_dict["websocket.sid"] == "sid456"
                    assert attribute_dict["websocket.namespace"] == "/chat"

    @pytest.mark.asyncio
    async def test_decorator_extracts_event_data(self):
        """Test that decorator extracts task_id, team_id, subtask_id from event data."""

        class MockNamespace:
            namespace = "/chat"

            async def get_session(self, sid):
                return {"user_id": 123, "user_name": "testuser"}

            @trace_websocket_event(extract_event_data=True)
            async def trigger_event(self, event, sid, *args):
                return "success"

        ns = MockNamespace()

        event_data = {
            "task_id": 789,
            "team_id": 456,
            "subtask_id": 123,
        }

        with patch("app.api.ws.decorators.settings.OTEL_ENABLED", True):
            with patch("app.api.ws.decorators.is_telemetry_enabled", return_value=True):
                with patch("app.api.ws.decorators.trace.get_tracer") as mock_tracer:
                    mock_span = Mock()
                    mock_span.is_recording.return_value = True
                    mock_context = Mock()
                    mock_context.__enter__ = Mock(return_value=mock_span)
                    mock_context.__exit__ = Mock(return_value=None)
                    mock_tracer.return_value.start_as_current_span.return_value = (
                        mock_context
                    )

                    await ns.trigger_event("chat:send", "sid123", event_data)

                    # Verify event data was extracted (using dot notation)
                    calls = mock_span.set_attribute.call_args_list
                    attribute_dict = {call[0][0]: call[0][1] for call in calls}

                    assert attribute_dict["task.id"] == 789
                    assert attribute_dict["team_id"] == 456
                    assert attribute_dict["subtask.id"] == 123

    @pytest.mark.asyncio
    async def test_decorator_handles_none_values_safely(self):
        """Test that decorator doesn't set attributes for None values."""

        class MockNamespace:
            namespace = "/chat"

            async def get_session(self, sid):
                return {"user_id": 123, "user_name": "testuser"}

            @trace_websocket_event(extract_event_data=True)
            async def trigger_event(self, event, sid, *args):
                return "success"

        ns = MockNamespace()

        event_data = {
            "task_id": None,  # Should not be set
            "team_id": 456,  # Should be set
            "subtask_id": None,  # Should not be set
        }

        with patch("app.api.ws.decorators.settings.OTEL_ENABLED", True):
            with patch("app.api.ws.decorators.is_telemetry_enabled", return_value=True):
                with patch("app.api.ws.decorators.trace.get_tracer") as mock_tracer:
                    mock_span = Mock()
                    mock_span.is_recording.return_value = True
                    mock_context = Mock()
                    mock_context.__enter__ = Mock(return_value=mock_span)
                    mock_context.__exit__ = Mock(return_value=None)
                    mock_tracer.return_value.start_as_current_span.return_value = (
                        mock_context
                    )

                    await ns.trigger_event("chat:send", "sid123", event_data)

                    # Get all set_attribute calls
                    calls = mock_span.set_attribute.call_args_list
                    attribute_dict = {call[0][0]: call[0][1] for call in calls}

                    # task.id=None should not be set (using dot notation)
                    assert (
                        "task.id" not in attribute_dict
                        or attribute_dict.get("task.id") is not None
                    )

                    # team_id=456 should be set
                    assert attribute_dict.get("team_id") == 456

                    # subtask.id=None should not be set (using dot notation)
                    assert (
                        "subtask.id" not in attribute_dict
                        or attribute_dict.get("subtask.id") is not None
                    )

    @pytest.mark.asyncio
    async def test_decorator_excludes_specified_events(self):
        """Test that decorator skips tracing for excluded events."""

        class MockNamespace:
            namespace = "/chat"

            @trace_websocket_event(exclude_events={"ping", "pong"})
            async def trigger_event(self, event, sid, *args):
                return f"handled_{event}"

        ns = MockNamespace()

        with patch("app.api.ws.decorators.trace.get_tracer") as mock_tracer:
            # Test excluded event
            result = await ns.trigger_event("ping", "sid123")
            assert result == "handled_ping"
            # Tracer should not be called for excluded events
            assert not mock_tracer.called

            # Test non-excluded event
            with patch("app.api.ws.decorators.settings.OTEL_ENABLED", True):
                with patch(
                    "app.api.ws.decorators.is_telemetry_enabled", return_value=True
                ):
                    mock_span = Mock()
                    mock_span.is_recording.return_value = True
                    mock_context = Mock()
                    mock_context.__enter__ = Mock(return_value=mock_span)
                    mock_context.__exit__ = Mock(return_value=None)
                    mock_tracer.return_value.start_as_current_span.return_value = (
                        mock_context
                    )

                    result = await ns.trigger_event("chat:send", "sid456")
                    assert result == "handled_chat:send"
                    # Tracer should be called for non-excluded events
                    assert mock_tracer.called

    @pytest.mark.asyncio
    async def test_decorator_records_exceptions(self):
        """Test that decorator records exceptions in span."""

        class MockNamespace:
            namespace = "/chat"

            async def get_session(self, sid):
                return {"user_id": 123, "user_name": "testuser"}

            @trace_websocket_event()
            async def trigger_event(self, event, sid, *args):
                raise ValueError("Test error")

        ns = MockNamespace()

        with patch("app.api.ws.decorators.settings.OTEL_ENABLED", True):
            with patch("app.api.ws.decorators.is_telemetry_enabled", return_value=True):
                with patch("app.api.ws.decorators.trace.get_tracer") as mock_tracer:
                    mock_span = Mock()
                    mock_span.is_recording.return_value = True
                    mock_context = Mock()
                    mock_context.__enter__ = Mock(return_value=mock_span)
                    mock_context.__exit__ = Mock(return_value=None)
                    mock_tracer.return_value.start_as_current_span.return_value = (
                        mock_context
                    )

                    with pytest.raises(ValueError, match="Test error"):
                        await ns.trigger_event("test:event", "sid123")

                    # Verify exception was recorded
                    assert mock_span.record_exception.called
                    # Verify span status was set to ERROR
                    assert mock_span.set_status.called

    @pytest.mark.asyncio
    async def test_decorator_sets_request_context(self):
        """Test that decorator sets request context for non-connect events."""

        class MockNamespace:
            namespace = "/chat"

            async def get_session(self, sid):
                return {"user_id": 123, "user_name": "testuser"}

            @trace_websocket_event()
            async def trigger_event(self, event, sid, *args):
                return "success"

        ns = MockNamespace()

        with patch("app.api.ws.decorators.set_request_context") as mock_set_request:
            with patch("app.api.ws.decorators.settings.OTEL_ENABLED", False):
                # Non-connect event should set request context
                await ns.trigger_event("chat:send", "sid123")
                assert mock_set_request.called

                # Reset mock
                mock_set_request.reset_mock()

                # Connect event should not set request context
                await ns.trigger_event("connect", "sid456")
                assert not mock_set_request.called

    @pytest.mark.asyncio
    async def test_decorator_restores_user_context(self):
        """Test that decorator restores user context from session."""

        class MockNamespace:
            namespace = "/chat"

            async def get_session(self, sid):
                return {"user_id": 789, "user_name": "john"}

            @trace_websocket_event()
            async def trigger_event(self, event, sid, *args):
                return "success"

        ns = MockNamespace()

        with patch("app.api.ws.decorators.set_user_context") as mock_set_user:
            with patch("app.api.ws.decorators.settings.OTEL_ENABLED", False):
                await ns.trigger_event("chat:send", "sid123")

                # Verify user context was set
                mock_set_user.assert_called_once_with(user_id="789", user_name="john")

    @pytest.mark.asyncio
    async def test_decorator_gracefully_handles_session_errors(self):
        """Test that decorator handles session lookup errors gracefully."""

        class MockNamespace:
            namespace = "/chat"

            async def get_session(self, sid):
                raise Exception("Session lookup failed")

            @trace_websocket_event()
            async def trigger_event(self, event, sid, *args):
                return "success"

        ns = MockNamespace()

        # Should not raise exception even if session lookup fails
        with patch("app.api.ws.decorators.settings.OTEL_ENABLED", False):
            result = await ns.trigger_event("chat:send", "sid123")
            assert result == "success"


class TestSafeSetAttribute:
    """Test suite for _safe_set_attribute helper."""

    def test_sets_attribute_for_valid_value(self):
        """Test that attribute is set for non-None values."""
        mock_span = Mock()
        _safe_set_attribute(mock_span, "test_key", "test_value")
        mock_span.set_attribute.assert_called_once_with("test_key", "test_value")

    def test_skips_none_values(self):
        """Test that attribute is not set for None values."""
        mock_span = Mock()
        _safe_set_attribute(mock_span, "test_key", None)
        assert not mock_span.set_attribute.called

    def test_handles_set_attribute_errors(self):
        """Test that errors in set_attribute are caught."""
        mock_span = Mock()
        mock_span.set_attribute.side_effect = Exception("OTLP error")

        # Should not raise exception
        _safe_set_attribute(mock_span, "test_key", "test_value")


class TestSetEventDataAttributes:
    """Test suite for _set_event_data_attributes helper."""

    def test_extracts_all_fields(self):
        """Test that all event data fields are extracted."""
        mock_span = Mock()
        event_data = {
            "task_id": 123,
            "team_id": 456,
            "subtask_id": 789,
        }

        _set_event_data_attributes(mock_span, event_data)

        # Verify all fields were set
        calls = mock_span.set_attribute.call_args_list
        assert len(calls) == 3

    def test_handles_missing_fields(self):
        """Test that missing fields are handled gracefully."""
        mock_span = Mock()
        event_data = {
            "task_id": 123,
            # team_id and subtask_id missing
        }

        # Should not raise exception
        _set_event_data_attributes(mock_span, event_data)

        # Only task_id should be set
        calls = mock_span.set_attribute.call_args_list
        assert len(calls) == 1

    def test_handles_none_values(self):
        """Test that None values are not set."""
        mock_span = Mock()
        event_data = {
            "task_id": None,
            "team_id": 456,
            "subtask_id": None,
        }

        _set_event_data_attributes(mock_span, event_data)

        # Only team_id should be set
        calls = mock_span.set_attribute.call_args_list
        assert len(calls) == 1
        assert calls[0][0][0] == "team_id"
        assert calls[0][0][1] == 456
