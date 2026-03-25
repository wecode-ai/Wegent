# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Tests for large data logging utilities.

These tests verify that large data is properly stored in span events
while metadata is stored in span attributes.
"""

import json
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

# Add shared directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from shared.telemetry.context.large_data import (
    log_json_body,
    log_large_attribute,
    log_large_string_list,
)


@pytest.mark.unit
class TestLogLargeAttribute:
    """Tests for log_large_attribute function."""

    @patch("shared.telemetry.context.large_data.set_span_attributes")
    @patch("shared.telemetry.context.large_data.add_span_event")
    def test_log_string_data(self, mock_add_event, mock_set_attrs):
        """Test logging a simple string value."""
        log_large_attribute("request.body", "Hello World")

        # Verify attributes were set
        mock_set_attrs.assert_called_once()
        attrs = mock_set_attrs.call_args[0][0]
        assert attrs["request.body.length"] == 11
        assert attrs["request.body.preview"] == "Hello World"

        # Verify event was added
        mock_add_event.assert_called_once()
        event_name = mock_add_event.call_args[0][0]
        event_attrs = mock_add_event.call_args[0][1]
        assert event_name == "request.body.data"
        assert event_attrs["data"] == "Hello World"

    @patch("shared.telemetry.context.large_data.set_span_attributes")
    @patch("shared.telemetry.context.large_data.add_span_event")
    def test_log_data_truncated_in_attribute(self, mock_add_event, mock_set_attrs):
        """Test that long data is truncated in attribute but full in event."""
        long_data = "x" * 200
        log_large_attribute("response.body", long_data, max_attr_length=50)

        # Verify attribute is truncated
        attrs = mock_set_attrs.call_args[0][0]
        assert attrs["response.body.length"] == 200
        assert attrs["response.body.preview"] == "x" * 50 + "..."

        # Verify event has full data (within default max_event_length)
        event_attrs = mock_add_event.call_args[0][1]
        assert event_attrs["data"] == long_data

    @patch("shared.telemetry.context.large_data.set_span_attributes")
    @patch("shared.telemetry.context.large_data.add_span_event")
    def test_log_data_truncated_in_event(self, mock_add_event, mock_set_attrs):
        """Test that very long data is truncated in event."""
        very_long_data = "x" * 15000
        log_large_attribute(
            "large.payload", very_long_data, max_attr_length=50, max_event_length=1000
        )

        # Verify event is truncated
        event_attrs = mock_add_event.call_args[0][1]
        assert event_attrs["data"].endswith("...[truncated from 15000 chars]")
        assert len(event_attrs["data"]) <= 1040  # 1000 + truncation message (~35 chars)

    @patch("shared.telemetry.context.large_data.set_span_attributes")
    @patch("shared.telemetry.context.large_data.add_span_event")
    def test_log_non_string_data(self, mock_add_event, mock_set_attrs):
        """Test logging non-string data (converted to string)."""
        data = {"key": "value", "number": 42}
        log_large_attribute("config.data", data)

        attrs = mock_set_attrs.call_args[0][0]
        assert attrs["config.data.length"] == len(str(data))

        event_attrs = mock_add_event.call_args[0][1]
        assert event_attrs["data"] == str(data)

    @patch("shared.telemetry.context.large_data.set_span_attributes")
    @patch("shared.telemetry.context.large_data.add_span_event")
    def test_custom_event_name(self, mock_add_event, mock_set_attrs):
        """Test using custom event name."""
        log_large_attribute("data", "test", event_name="custom.event")

        event_name = mock_add_event.call_args[0][0]
        assert event_name == "custom.event"

    @patch("shared.telemetry.context.large_data.set_span_attributes")
    @patch("shared.telemetry.context.large_data.add_span_event")
    def test_extra_attributes(self, mock_add_event, mock_set_attrs):
        """Test including extra attributes in event."""
        extra = {"task_id": 123, "user": "test"}
        log_large_attribute("data", "test", extra_attributes=extra)

        event_attrs = mock_add_event.call_args[0][1]
        assert event_attrs["data"] == "test"
        assert event_attrs["task_id"] == 123
        assert event_attrs["user"] == "test"

    @patch("shared.telemetry.context.large_data.set_span_attributes")
    @patch("shared.telemetry.context.large_data.add_span_event")
    @patch("shared.telemetry.context.large_data.logger")
    def test_error_handling(self, mock_logger, mock_add_event, mock_set_attrs):
        """Test that errors are logged but not raised."""
        mock_set_attrs.side_effect = Exception("Test error")

        # Should not raise
        log_large_attribute("data", "test")

        mock_logger.debug.assert_called_once()
        assert "Test error" in str(mock_logger.debug.call_args[0][0])


@pytest.mark.unit
class TestLogLargeStringList:
    """Tests for log_large_string_list function."""

    @patch("shared.telemetry.context.large_data.set_span_attributes")
    @patch("shared.telemetry.context.large_data.add_span_event")
    def test_log_small_list(self, mock_add_event, mock_set_attrs):
        """Test logging a small list of strings."""
        items = ["id1", "id2", "id3"]
        log_large_string_list("file.ids", items)

        # Verify attributes
        attrs = mock_set_attrs.call_args[0][0]
        assert attrs["file.ids.count"] == 3
        assert json.loads(attrs["file.ids.preview"]) == items

        # Verify event
        event_name = mock_add_event.call_args[0][0]
        event_attrs = mock_add_event.call_args[0][1]
        assert event_name == "file.ids.list"
        assert json.loads(event_attrs["items"]) == items
        assert "truncated" not in event_attrs

    @patch("shared.telemetry.context.large_data.set_span_attributes")
    @patch("shared.telemetry.context.large_data.add_span_event")
    def test_log_large_list_truncated_preview(self, mock_add_event, mock_set_attrs):
        """Test that large list has truncated preview in attributes."""
        items = [f"id{i}" for i in range(20)]
        log_large_string_list("tool.calls", items, max_attr_items=5)

        # Verify attribute preview is truncated
        attrs = mock_set_attrs.call_args[0][0]
        assert attrs["tool.calls.count"] == 20
        preview = json.loads(attrs["tool.calls.preview"])
        assert len(preview) == 5
        assert preview == items[:5]

        # Verify event has full list
        event_attrs = mock_add_event.call_args[0][1]
        assert json.loads(event_attrs["items"]) == items

    @patch("shared.telemetry.context.large_data.set_span_attributes")
    @patch("shared.telemetry.context.large_data.add_span_event")
    def test_log_large_list_truncated_event(self, mock_add_event, mock_set_attrs):
        """Test that very large list is truncated in event."""
        items = [f"id{i}" for i in range(1500)]
        log_large_string_list("file.ids", items, max_event_items=1000)

        # Verify event is truncated
        event_attrs = mock_add_event.call_args[0][1]
        event_items = json.loads(event_attrs["items"])
        assert len(event_items) == 1000
        assert event_attrs["truncated"] is True
        assert event_attrs["total_count"] == 1500

    @patch("shared.telemetry.context.large_data.set_span_attributes")
    @patch("shared.telemetry.context.large_data.add_span_event")
    def test_empty_list(self, mock_add_event, mock_set_attrs):
        """Test logging an empty list."""
        log_large_string_list("empty.list", [])

        attrs = mock_set_attrs.call_args[0][0]
        assert attrs["empty.list.count"] == 0
        assert json.loads(attrs["empty.list.preview"]) == []

        event_attrs = mock_add_event.call_args[0][1]
        assert json.loads(event_attrs["items"]) == []

    @patch("shared.telemetry.context.large_data.set_span_attributes")
    @patch("shared.telemetry.context.large_data.add_span_event")
    def test_custom_event_name(self, mock_add_event, mock_set_attrs):
        """Test using custom event name."""
        log_large_string_list("data", ["a", "b"], event_name="custom.list")

        event_name = mock_add_event.call_args[0][0]
        assert event_name == "custom.list"

    @patch("shared.telemetry.context.large_data.set_span_attributes")
    @patch("shared.telemetry.context.large_data.add_span_event")
    @patch("shared.telemetry.context.large_data.logger")
    def test_error_handling(self, mock_logger, mock_add_event, mock_set_attrs):
        """Test that errors are logged but not raised."""
        mock_set_attrs.side_effect = Exception("Test error")

        # Should not raise
        log_large_string_list("data", ["a", "b"])

        mock_logger.debug.assert_called_once()


@pytest.mark.unit
class TestLogJsonBody:
    """Tests for log_json_body function."""

    @patch("shared.telemetry.context.large_data.set_span_attributes")
    @patch("shared.telemetry.context.large_data.add_span_event")
    def test_log_simple_dict(self, mock_add_event, mock_set_attrs):
        """Test logging a simple JSON object."""
        body = {"key": "value", "number": 42}
        log_json_body("request.body", body)

        # Verify attributes
        attrs = mock_set_attrs.call_args[0][0]
        assert attrs["request.body.has_messages"] is False
        assert attrs["request.body.is_stream"] is False
        assert "request.body.preview" in attrs
        assert attrs["request.body.length"] == len(json.dumps(body))

        # Verify event
        event_name = mock_add_event.call_args[0][0]
        event_attrs = mock_add_event.call_args[0][1]
        assert event_name == "request.body.json"
        assert json.loads(event_attrs["body"]) == body

    @patch("shared.telemetry.context.large_data.set_span_attributes")
    @patch("shared.telemetry.context.large_data.add_span_event")
    def test_log_with_messages(self, mock_add_event, mock_set_attrs):
        """Test logging JSON with messages array."""
        body = {
            "messages": [
                {"role": "user", "content": "Hello"},
                {"role": "assistant", "content": "Hi"},
            ],
            "model": "gpt-4",
        }
        log_json_body("request.body", body)

        attrs = mock_set_attrs.call_args[0][0]
        assert attrs["request.body.has_messages"] is True
        assert attrs["request.body.message_count"] == 2
        assert attrs["request.body.model"] == "gpt-4"

    @patch("shared.telemetry.context.large_data.set_span_attributes")
    @patch("shared.telemetry.context.large_data.add_span_event")
    def test_log_with_stream(self, mock_add_event, mock_set_attrs):
        """Test logging JSON with stream flag."""
        body = {"stream": True, "model": "claude-3"}
        log_json_body("request.body", body)

        attrs = mock_set_attrs.call_args[0][0]
        assert attrs["request.body.is_stream"] is True
        assert attrs["request.body.model"] == "claude-3"

    @patch("shared.telemetry.context.large_data.set_span_attributes")
    @patch("shared.telemetry.context.large_data.add_span_event")
    def test_log_with_task_id(self, mock_add_event, mock_set_attrs):
        """Test logging JSON with task_id."""
        body = {"task_id": 12345, "data": "test"}
        log_json_body("request.body", body)

        attrs = mock_set_attrs.call_args[0][0]
        assert attrs["request.body.task_id"] == 12345

    @patch("shared.telemetry.context.large_data.set_span_attributes")
    @patch("shared.telemetry.context.large_data.add_span_event")
    def test_log_json_string(self, mock_add_event, mock_set_attrs):
        """Test logging a JSON string."""
        body = '{"key": "value", "messages": [{"role": "user"}]}'
        log_json_body("response.body", body)

        attrs = mock_set_attrs.call_args[0][0]
        assert attrs["response.body.has_messages"] is True
        assert attrs["response.body.message_count"] == 1

        event_attrs = mock_add_event.call_args[0][1]
        assert json.loads(event_attrs["body"]) == json.loads(body)

    @patch("shared.telemetry.context.large_data.set_span_attributes")
    @patch("shared.telemetry.context.large_data.add_span_event")
    def test_log_invalid_json_string(self, mock_add_event, mock_set_attrs):
        """Test logging an invalid JSON string (falls back to log_large_attribute)."""
        body = "not valid json"
        log_json_body("request.body", body)

        # Should fall back to log_large_attribute behavior
        attrs = mock_set_attrs.call_args[0][0]
        assert "request.body.length" in attrs
        assert "request.body.preview" in attrs

        event_name = mock_add_event.call_args[0][0]
        assert event_name == "request.body.json"

    @patch("shared.telemetry.context.large_data.set_span_attributes")
    @patch("shared.telemetry.context.large_data.add_span_event")
    def test_log_truncated_preview(self, mock_add_event, mock_set_attrs):
        """Test that long JSON is truncated in preview."""
        body = {"data": "x" * 200}
        log_json_body("request.body", body, max_attr_preview=50)

        attrs = mock_set_attrs.call_args[0][0]
        preview = attrs["request.body.preview"]
        assert preview.endswith("...")
        assert len(preview) <= 53  # 50 + "..."

    @patch("shared.telemetry.context.large_data.set_span_attributes")
    @patch("shared.telemetry.context.large_data.add_span_event")
    def test_log_truncated_event(self, mock_add_event, mock_set_attrs):
        """Test that very large JSON is truncated in event."""
        body = {"data": "x" * 20000}
        log_json_body("request.body", body, max_event_size=1000)

        event_attrs = mock_add_event.call_args[0][1]
        assert "...[truncated from" in event_attrs["body"]

    @patch("shared.telemetry.context.large_data.set_span_attributes")
    @patch("shared.telemetry.context.large_data.add_span_event")
    @patch("shared.telemetry.context.large_data.logger")
    def test_error_handling(self, mock_logger, mock_add_event, mock_set_attrs):
        """Test that errors are logged but not raised."""
        mock_set_attrs.side_effect = Exception("Test error")

        # Should not raise
        log_json_body("data", {"key": "value"})

        mock_logger.debug.assert_called_once()
