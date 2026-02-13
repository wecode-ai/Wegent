# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for PreviewSubscriptionTool.

This module tests:
- Preview generation without creating subscription
- Preview storage with TTL
- Preview retrieval and cleanup
- Preview table formatting
- Input validation
"""

import json
import time
from unittest.mock import patch

import pytest

from chat_shell.tools.builtin.preview_subscription import (
    PreviewSubscriptionInput,
    PreviewSubscriptionTool,
    _cleanup_expired_previews,
    _cleanup_preview,
    _get_preview,
    _preview_storage,
    _preview_timestamps,
    _store_preview,
    clear_preview,
    get_preview_data,
)


class TestPreviewSubscriptionInput:
    """Tests for PreviewSubscriptionInput schema."""

    def test_cron_trigger_input_valid(self):
        """Test valid cron trigger input."""
        # Arrange & Act
        input_data = PreviewSubscriptionInput(
            display_name="Daily Report",
            trigger_type="cron",
            cron_expression="0 9 * * *",
            prompt_template="Generate daily report for {{date}}",
        )

        # Assert
        assert input_data.display_name == "Daily Report"
        assert input_data.trigger_type == "cron"
        assert input_data.cron_expression == "0 9 * * *"
        assert "{{date}}" in input_data.prompt_template

    def test_interval_trigger_input_valid(self):
        """Test valid interval trigger input."""
        # Arrange & Act
        input_data = PreviewSubscriptionInput(
            display_name="Hourly Check",
            trigger_type="interval",
            interval_value=2,
            interval_unit="hours",
            prompt_template="Check system status",
        )

        # Assert
        assert input_data.trigger_type == "interval"
        assert input_data.interval_value == 2
        assert input_data.interval_unit == "hours"

    def test_one_time_trigger_input_valid(self):
        """Test valid one-time trigger input."""
        # Arrange & Act
        input_data = PreviewSubscriptionInput(
            display_name="One-time Task",
            trigger_type="one_time",
            execute_at="2025-01-20T09:00:00",
            prompt_template="Execute scheduled task",
        )

        # Assert
        assert input_data.trigger_type == "one_time"
        assert input_data.execute_at == "2025-01-20T09:00:00"

    def test_preserve_history_default_false(self):
        """Test that preserve_history defaults to False."""
        # Arrange & Act
        input_data = PreviewSubscriptionInput(
            display_name="Test",
            trigger_type="cron",
            cron_expression="0 9 * * *",
            prompt_template="Test",
        )

        # Assert
        assert input_data.preserve_history is False
        assert input_data.history_message_count == 10

    def test_default_configuration_values(self):
        """Test default configuration values."""
        # Arrange & Act
        input_data = PreviewSubscriptionInput(
            display_name="Test",
            trigger_type="cron",
            cron_expression="0 9 * * *",
            prompt_template="Test",
        )

        # Assert
        assert input_data.retry_count == 1
        assert input_data.timeout_seconds == 600
        assert input_data.description is None


class TestPreviewStorage:
    """Tests for preview storage mechanism."""

    def setup_method(self):
        """Clear storage before each test."""
        _preview_storage.clear()
        _preview_timestamps.clear()

    def teardown_method(self):
        """Clear storage after each test."""
        _preview_storage.clear()
        _preview_timestamps.clear()

    def test_store_preview(self):
        """Test storing preview data."""
        # Arrange
        preview_id = "preview_abc123"
        data = {"display_name": "Test", "trigger_type": "cron"}

        # Act
        _store_preview(preview_id, data)

        # Assert
        assert preview_id in _preview_storage
        assert _preview_storage[preview_id] == data
        assert preview_id in _preview_timestamps

    def test_get_preview_existing(self):
        """Test retrieving existing preview."""
        # Arrange
        preview_id = "preview_abc123"
        data = {"display_name": "Test", "trigger_type": "cron"}
        _store_preview(preview_id, data)

        # Act
        result = _get_preview(preview_id)

        # Assert
        assert result == data

    def test_get_preview_nonexistent(self):
        """Test retrieving non-existent preview."""
        # Act
        result = _get_preview("preview_nonexistent")

        # Assert
        assert result is None

    def test_get_preview_expired(self):
        """Test retrieving expired preview."""
        # Arrange
        preview_id = "preview_expired"
        data = {"display_name": "Test"}
        _store_preview(preview_id, data)

        # Manually set timestamp to be expired
        _preview_timestamps[preview_id] = (
            time.time() - 400
        )  # 400 seconds ago (TTL is 300)

        # Act
        result = _get_preview(preview_id)

        # Assert
        assert result is None
        assert preview_id not in _preview_storage

    def test_cleanup_preview(self):
        """Test cleaning up specific preview."""
        # Arrange
        preview_id = "preview_cleanup"
        _store_preview(preview_id, {"test": "data"})

        # Act
        _cleanup_preview(preview_id)

        # Assert
        assert preview_id not in _preview_storage
        assert preview_id not in _preview_timestamps

    def test_cleanup_expired_previews(self):
        """Test cleaning up all expired previews."""
        # Arrange
        expired_id1 = "preview_expired1"
        expired_id2 = "preview_expired2"
        valid_id = "preview_valid"

        _store_preview(expired_id1, {"test": "data1"})
        _store_preview(expired_id2, {"test": "data2"})
        _store_preview(valid_id, {"test": "data3"})

        # Set expired timestamps
        _preview_timestamps[expired_id1] = time.time() - 400
        _preview_timestamps[expired_id2] = time.time() - 500
        # valid_id keeps current timestamp

        # Act
        _cleanup_expired_previews()

        # Assert
        assert expired_id1 not in _preview_storage
        assert expired_id2 not in _preview_storage
        assert valid_id in _preview_storage

    def test_get_preview_data_public_interface(self):
        """Test get_preview_data public interface function."""
        # Arrange
        preview_id = "preview_public"
        data = {"display_name": "Test Task"}
        _store_preview(preview_id, data)

        # Act
        result = get_preview_data(preview_id)

        # Assert
        assert result == data

    def test_clear_preview_public_interface(self):
        """Test clear_preview public interface function."""
        # Arrange
        preview_id = "preview_clear"
        _store_preview(preview_id, {"test": "data"})

        # Act
        clear_preview(preview_id)

        # Assert
        assert preview_id not in _preview_storage


class TestPreviewSubscriptionToolValidation:
    """Tests for PreviewSubscriptionTool input validation."""

    def setup_method(self):
        """Set up test fixtures."""
        self.tool = PreviewSubscriptionTool(
            user_id=1,
            team_id=10,
            team_name="test-team",
            team_namespace="default",
            timezone="Asia/Shanghai",
        )

    def test_validate_cron_missing_expression(self):
        """Test validation fails when cron expression is missing."""
        # Act
        error = self.tool._validate_trigger_config(
            trigger_type="cron",
            cron_expression=None,
            interval_value=None,
            interval_unit=None,
            execute_at=None,
        )

        # Assert
        assert error is not None
        assert "cron_expression is required" in error

    def test_validate_cron_invalid_expression(self):
        """Test validation fails for invalid cron expression."""
        # Act
        error = self.tool._validate_trigger_config(
            trigger_type="cron",
            cron_expression="0 9 * *",  # Only 4 parts instead of 5
            interval_value=None,
            interval_unit=None,
            execute_at=None,
        )

        # Assert
        assert error is not None
        assert "Invalid cron expression" in error

    def test_validate_interval_missing_value(self):
        """Test validation fails when interval value is missing."""
        # Act
        error = self.tool._validate_trigger_config(
            trigger_type="interval",
            cron_expression=None,
            interval_value=None,
            interval_unit="hours",
            execute_at=None,
        )

        # Assert
        assert error is not None
        assert "interval_value is required" in error

    def test_validate_one_time_missing_execute_at(self):
        """Test validation fails when execute_at is missing."""
        # Act
        error = self.tool._validate_trigger_config(
            trigger_type="one_time",
            cron_expression=None,
            interval_value=None,
            interval_unit=None,
            execute_at=None,
        )

        # Assert
        assert error is not None
        assert "execute_at is required" in error


class TestPreviewSubscriptionToolFormatting:
    """Tests for PreviewSubscriptionTool formatting."""

    def setup_method(self):
        """Set up test fixtures."""
        self.tool = PreviewSubscriptionTool(
            user_id=1,
            team_id=10,
            team_name="test-team",
            team_namespace="default",
            timezone="Asia/Shanghai",
        )
        # Clear storage
        _preview_storage.clear()
        _preview_timestamps.clear()

    def teardown_method(self):
        """Clear storage after each test."""
        _preview_storage.clear()
        _preview_timestamps.clear()

    def test_format_cron_trigger_description(self):
        """Test formatting cron trigger description."""
        # Act
        desc = self.tool._format_trigger_description(
            "cron", {"expression": "0 9 * * *", "timezone": "Asia/Shanghai"}
        )

        # Assert
        assert "0 9 * * *" in desc
        assert "Asia/Shanghai" in desc

    def test_format_interval_trigger_description(self):
        """Test formatting interval trigger description."""
        # Act
        desc = self.tool._format_trigger_description(
            "interval", {"value": 2, "unit": "hours"}
        )

        # Assert
        assert "2" in desc
        assert "小时" in desc

    def test_format_one_time_trigger_description(self):
        """Test formatting one-time trigger description."""
        # Act
        desc = self.tool._format_trigger_description(
            "one_time", {"execute_at": "2025-01-20T09:00:00", "timezone": "UTC"}
        )

        # Assert
        assert "2025-01-20T09:00:00" in desc
        assert "UTC" in desc

    def test_format_preview_table_cron(self):
        """Test formatting preview table for cron trigger."""
        # Act
        table = self.tool._format_preview_table(
            display_name="每日报告",
            description="每天早上9点生成报告",
            trigger_type="cron",
            trigger_config={"expression": "0 9 * * *", "timezone": "Asia/Shanghai"},
            prompt_template="Generate daily report",
            preserve_history=True,
            history_message_count=20,
            retry_count=2,
            timeout_seconds=1200,
        )

        # Assert
        assert "订阅任务预览" in table
        assert "每日报告" in table
        assert "0 9 * * *" in table
        assert "保留历史" in table
        assert "是" in table
        assert "执行" in table  # Confirmation prompt
        assert "取消" in table  # Cancel option

    def test_format_preview_table_interval(self):
        """Test formatting preview table for interval trigger."""
        # Act
        table = self.tool._format_preview_table(
            display_name="定时检查",
            description=None,
            trigger_type="interval",
            trigger_config={"value": 30, "unit": "minutes"},
            prompt_template="Check status",
            preserve_history=False,
            history_message_count=10,
            retry_count=1,
            timeout_seconds=600,
        )

        # Assert
        assert "定时检查" in table
        assert "30" in table
        assert "分钟" in table
        assert "否" in table  # Not preserving history

    def test_format_preview_table_escapes_pipe(self):
        """Test that pipe characters are escaped in markdown table."""
        # Act
        table = self.tool._format_preview_table(
            display_name="Test",
            description="Test | with pipes",
            trigger_type="cron",
            trigger_config={"expression": "0 9 * * *"},
            prompt_template="Test | prompt",
            preserve_history=False,
            history_message_count=10,
            retry_count=1,
            timeout_seconds=600,
        )

        # Assert
        assert "\\|" in table  # Pipes should be escaped

    def test_format_preview_table_truncates_long_prompt(self):
        """Test that long prompts are truncated."""
        # Arrange
        long_prompt = "A" * 150

        # Act
        table = self.tool._format_preview_table(
            display_name="Test",
            description=None,
            trigger_type="cron",
            trigger_config={"expression": "0 9 * * *"},
            prompt_template=long_prompt,
            preserve_history=False,
            history_message_count=10,
            retry_count=1,
            timeout_seconds=600,
        )

        # Assert - verify truncation is applied
        assert "..." in table
        # The prompt in table should be truncated (max 100 chars + "...")
        assert "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA..." in table


class TestPreviewSubscriptionToolAsyncExecution:
    """Tests for PreviewSubscriptionTool async execution."""

    def setup_method(self):
        """Set up test fixtures."""
        self.tool = PreviewSubscriptionTool(
            user_id=1,
            team_id=10,
            team_name="test-team",
            team_namespace="default",
            timezone="Asia/Shanghai",
        )
        # Clear storage
        _preview_storage.clear()
        _preview_timestamps.clear()

    def teardown_method(self):
        """Clear storage after each test."""
        _preview_storage.clear()
        _preview_timestamps.clear()

    def test_sync_run_raises_not_implemented(self):
        """Test that sync _run raises NotImplementedError."""
        # Assert
        with pytest.raises(NotImplementedError):
            self.tool._run(
                display_name="Test",
                trigger_type="cron",
                prompt_template="Test",
                cron_expression="0 9 * * *",
            )

    @pytest.mark.asyncio
    async def test_arun_returns_error_for_invalid_cron(self):
        """Test that _arun returns error for invalid cron expression."""
        # Act
        result = await self.tool._arun(
            display_name="Test",
            trigger_type="cron",
            prompt_template="Test",
            cron_expression="invalid",
        )

        # Assert
        response = json.loads(result)
        assert response["success"] is False
        assert "Invalid cron expression" in response["error"]

    @pytest.mark.asyncio
    async def test_arun_generates_preview_for_valid_cron(self):
        """Test that _arun generates preview for valid cron expression."""
        # Act
        result = await self.tool._arun(
            display_name="Daily Report",
            trigger_type="cron",
            prompt_template="Generate report",
            cron_expression="0 9 * * *",
        )

        # Assert
        response = json.loads(result)
        assert response["success"] is True
        assert "preview_id" in response
        assert response["preview_id"].startswith("preview_")
        assert "preview_table" in response
        assert "订阅任务预览" in response["preview_table"]
        assert "Daily Report" in response["preview_table"]

    @pytest.mark.asyncio
    async def test_arun_stores_preview_data(self):
        """Test that _arun stores preview data in storage."""
        # Act
        result = await self.tool._arun(
            display_name="Test Task",
            trigger_type="interval",
            prompt_template="Test prompt",
            interval_value=2,
            interval_unit="hours",
            preserve_history=True,
            history_message_count=20,
        )

        # Assert
        response = json.loads(result)
        preview_id = response["preview_id"]

        # Verify data is stored
        stored_data = _get_preview(preview_id)
        assert stored_data is not None
        assert stored_data["display_name"] == "Test Task"
        assert stored_data["trigger_type"] == "interval"
        assert stored_data["preserve_history"] is True
        assert stored_data["history_message_count"] == 20
        assert stored_data["prompt_template"] == "Test prompt"
        assert stored_data["user_id"] == 1
        assert stored_data["team_id"] == 10


class TestPreviewSubscriptionToolMetadata:
    """Tests for PreviewSubscriptionTool metadata."""

    def test_tool_name(self):
        """Test tool name is correct."""
        # Arrange
        tool = PreviewSubscriptionTool(
            user_id=1,
            team_id=10,
            team_name="test",
            team_namespace="default",
            timezone="UTC",
        )

        # Assert
        assert tool.name == "preview_subscription"

    def test_tool_display_name(self):
        """Test tool display name is correct."""
        # Arrange
        tool = PreviewSubscriptionTool(
            user_id=1,
            team_id=10,
            team_name="test",
            team_namespace="default",
            timezone="UTC",
        )

        # Assert
        assert tool.display_name == "预览订阅任务"

    def test_tool_args_schema(self):
        """Test tool args schema is correct."""
        # Arrange
        tool = PreviewSubscriptionTool(
            user_id=1,
            team_id=10,
            team_name="test",
            team_namespace="default",
            timezone="UTC",
        )

        # Assert
        assert tool.args_schema == PreviewSubscriptionInput

    def test_tool_description_contains_workflow(self):
        """Test tool description contains workflow instructions."""
        # Arrange
        tool = PreviewSubscriptionTool(
            user_id=1,
            team_id=10,
            team_name="test",
            team_namespace="default",
            timezone="UTC",
        )

        # Assert
        assert "preview_subscription" in tool.description
        assert "Workflow" in tool.description
        assert "preview_subscription" in tool.description
