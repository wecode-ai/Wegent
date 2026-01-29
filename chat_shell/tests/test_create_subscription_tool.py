# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for CreateSubscriptionTool.

This module tests:
- Input validation for different trigger types
- Trigger configuration building
- Unique name generation
- Package mode (backend service) creation
- HTTP mode (API) creation
- Success and error response formatting
"""

import json
from datetime import datetime
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from chat_shell.tools.builtin.create_subscription import (
    CreateSubscriptionInput,
    CreateSubscriptionTool,
)


class TestCreateSubscriptionInput:
    """Tests for CreateSubscriptionInput schema."""

    def test_cron_trigger_input_valid(self):
        """Test valid cron trigger input."""
        # Arrange & Act
        input_data = CreateSubscriptionInput(
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
        input_data = CreateSubscriptionInput(
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
        input_data = CreateSubscriptionInput(
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
        input_data = CreateSubscriptionInput(
            display_name="Test",
            trigger_type="cron",
            cron_expression="0 9 * * *",
            prompt_template="Test",
        )

        # Assert
        assert input_data.preserve_history is False
        assert input_data.history_message_count == 10

    def test_retry_count_bounds(self):
        """Test retry_count bounds validation."""
        # Valid retry count
        input_data = CreateSubscriptionInput(
            display_name="Test",
            trigger_type="cron",
            cron_expression="0 9 * * *",
            prompt_template="Test",
            retry_count=3,
        )
        assert input_data.retry_count == 3

    def test_timeout_seconds_bounds(self):
        """Test timeout_seconds bounds validation."""
        # Valid timeout
        input_data = CreateSubscriptionInput(
            display_name="Test",
            trigger_type="cron",
            cron_expression="0 9 * * *",
            prompt_template="Test",
            timeout_seconds=3600,
        )
        assert input_data.timeout_seconds == 3600


class TestCreateSubscriptionToolValidation:
    """Tests for CreateSubscriptionTool input validation."""

    def setup_method(self):
        """Set up test fixtures."""
        self.tool = CreateSubscriptionTool(
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

    def test_validate_cron_valid_expression(self):
        """Test validation passes for valid cron expression."""
        # Act
        error = self.tool._validate_trigger_config(
            trigger_type="cron",
            cron_expression="0 9 * * *",
            interval_value=None,
            interval_unit=None,
            execute_at=None,
        )

        # Assert
        assert error is None

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

    def test_validate_interval_missing_unit(self):
        """Test validation fails when interval unit is missing."""
        # Act
        error = self.tool._validate_trigger_config(
            trigger_type="interval",
            cron_expression=None,
            interval_value=2,
            interval_unit=None,
            execute_at=None,
        )

        # Assert
        assert error is not None
        assert "interval_unit is required" in error

    def test_validate_interval_negative_value(self):
        """Test validation fails for negative interval value."""
        # Act
        error = self.tool._validate_trigger_config(
            trigger_type="interval",
            cron_expression=None,
            interval_value=-1,
            interval_unit="hours",
            execute_at=None,
        )

        # Assert
        assert error is not None
        assert "must be positive" in error

    def test_validate_interval_valid(self):
        """Test validation passes for valid interval config."""
        # Act
        error = self.tool._validate_trigger_config(
            trigger_type="interval",
            cron_expression=None,
            interval_value=2,
            interval_unit="hours",
            execute_at=None,
        )

        # Assert
        assert error is None

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

    def test_validate_one_time_invalid_format(self):
        """Test validation fails for invalid execute_at format."""
        # Act
        error = self.tool._validate_trigger_config(
            trigger_type="one_time",
            cron_expression=None,
            interval_value=None,
            interval_unit=None,
            execute_at="invalid-date",
        )

        # Assert
        assert error is not None
        assert "Invalid execute_at format" in error

    def test_validate_one_time_valid(self):
        """Test validation passes for valid one-time config."""
        # Act
        error = self.tool._validate_trigger_config(
            trigger_type="one_time",
            cron_expression=None,
            interval_value=None,
            interval_unit=None,
            execute_at="2025-01-20T09:00:00",
        )

        # Assert
        assert error is None


class TestCreateSubscriptionToolTriggerConfig:
    """Tests for CreateSubscriptionTool trigger config building."""

    def setup_method(self):
        """Set up test fixtures."""
        self.tool = CreateSubscriptionTool(
            user_id=1,
            team_id=10,
            team_name="test-team",
            team_namespace="default",
            timezone="Asia/Shanghai",
        )

    def test_build_cron_trigger_config(self):
        """Test building cron trigger configuration."""
        # Act
        config = self.tool._build_trigger_config(
            trigger_type="cron",
            cron_expression="0 9 * * *",
            interval_value=None,
            interval_unit=None,
            execute_at=None,
        )

        # Assert
        assert config["expression"] == "0 9 * * *"
        assert config["timezone"] == "Asia/Shanghai"

    def test_build_interval_trigger_config(self):
        """Test building interval trigger configuration."""
        # Act
        config = self.tool._build_trigger_config(
            trigger_type="interval",
            cron_expression=None,
            interval_value=2,
            interval_unit="hours",
            execute_at=None,
        )

        # Assert
        assert config["value"] == 2
        assert config["unit"] == "hours"

    def test_build_one_time_trigger_config(self):
        """Test building one-time trigger configuration."""
        # Act
        config = self.tool._build_trigger_config(
            trigger_type="one_time",
            cron_expression=None,
            interval_value=None,
            interval_unit=None,
            execute_at="2025-01-20T09:00:00",
        )

        # Assert
        assert config["execute_at"] == "2025-01-20T09:00:00"
        # Verify timezone is included for proper UTC conversion
        assert config["timezone"] == "Asia/Shanghai"

    def test_build_one_time_trigger_config_includes_timezone(self):
        """Test that one-time trigger config includes user timezone for UTC conversion.

        This is critical for correct time handling: when a user in Asia/Shanghai
        sets execute_at='2025-01-20T09:00:00', the backend needs to know this is
        Shanghai time (UTC+8) to correctly convert it to UTC (01:00:00).
        """
        # Arrange - Create tool with different timezone
        tool_tokyo = CreateSubscriptionTool(
            user_id=1,
            team_id=10,
            team_name="test-team",
            team_namespace="default",
            timezone="Asia/Tokyo",
        )

        # Act
        config = tool_tokyo._build_trigger_config(
            trigger_type="one_time",
            cron_expression=None,
            interval_value=None,
            interval_unit=None,
            execute_at="2025-01-20T09:00:00",
        )

        # Assert
        assert config["execute_at"] == "2025-01-20T09:00:00"
        assert config["timezone"] == "Asia/Tokyo"


class TestCreateSubscriptionToolNameGeneration:
    """Tests for CreateSubscriptionTool name generation."""

    def setup_method(self):
        """Set up test fixtures."""
        self.tool = CreateSubscriptionTool(
            user_id=1,
            team_id=10,
            team_name="test-team",
            team_namespace="default",
            timezone="Asia/Shanghai",
        )

    def test_generate_unique_name_ascii(self):
        """Test generating unique name with ASCII display name."""
        # Act
        name = self.tool._generate_unique_name("Daily Report")

        # Assert
        assert name.startswith("sub-daily-report-")
        assert len(name) <= 70  # sub- + base(50) + - + suffix(8)

    def test_generate_unique_name_chinese(self):
        """Test generating unique name with Chinese display name."""
        # Act
        name = self.tool._generate_unique_name("每日报告")

        # Assert
        assert name.startswith("sub-")
        # Chinese characters are filtered out by ASCII encoding
        assert len(name) > 4

    def test_generate_unique_name_special_chars(self):
        """Test generating unique name with special characters."""
        # Act
        name = self.tool._generate_unique_name("Test!@#$%Task")

        # Assert
        assert name.startswith("sub-test")
        # Special characters should be filtered out
        assert "@" not in name
        assert "#" not in name

    def test_generate_unique_name_uniqueness(self):
        """Test that generated names are unique."""
        # Act
        name1 = self.tool._generate_unique_name("Test")
        name2 = self.tool._generate_unique_name("Test")

        # Assert
        assert name1 != name2


class TestCreateSubscriptionToolTriggerSummary:
    """Tests for CreateSubscriptionTool trigger summary formatting."""

    def setup_method(self):
        """Set up test fixtures."""
        self.tool = CreateSubscriptionTool(
            user_id=1,
            team_id=10,
            team_name="test-team",
            team_namespace="default",
            timezone="Asia/Shanghai",
        )

    def test_format_cron_trigger_summary(self):
        """Test formatting cron trigger summary."""
        # Act
        summary = self.tool._format_trigger_summary(
            "cron", {"expression": "0 9 * * *", "timezone": "Asia/Shanghai"}
        )

        # Assert
        assert "0 9 * * *" in summary
        assert "Asia/Shanghai" in summary

    def test_format_interval_trigger_summary(self):
        """Test formatting interval trigger summary."""
        # Act
        summary = self.tool._format_trigger_summary(
            "interval", {"value": 2, "unit": "hours"}
        )

        # Assert
        assert "2" in summary
        assert "小时" in summary  # Chinese for hours

    def test_format_one_time_trigger_summary(self):
        """Test formatting one-time trigger summary."""
        # Act
        summary = self.tool._format_trigger_summary(
            "one_time", {"execute_at": "2025-01-20T09:00:00"}
        )

        # Assert
        assert "2025-01-20T09:00:00" in summary


class TestCreateSubscriptionToolSuccessResponse:
    """Tests for CreateSubscriptionTool success response formatting."""

    def setup_method(self):
        """Set up test fixtures."""
        self.tool = CreateSubscriptionTool(
            user_id=1,
            team_id=10,
            team_name="test-team",
            team_namespace="default",
            timezone="Asia/Shanghai",
        )

    def test_format_success_response_with_datetime_object(self):
        """Test formatting success response with datetime object."""
        # Act
        response = self.tool._format_success_response(
            subscription_id=123,
            name="sub-test-abc12345",
            display_name="Test Task",
            trigger_type="cron",
            trigger_config={"expression": "0 9 * * *", "timezone": "UTC"},
            next_execution_time=datetime(2025, 1, 21, 9, 0, 0),
            preserve_history=True,
        )

        # Assert
        result = json.loads(response)
        assert result["success"] is True
        assert result["subscription"]["id"] == 123
        assert result["subscription"]["name"] == "sub-test-abc12345"
        assert result["subscription"]["display_name"] == "Test Task"
        assert result["subscription"]["preserve_history"] is True
        assert "2025-01-21" in result["subscription"]["next_execution_time"]
        assert "订阅任务创建成功" in result["message"]

    def test_format_success_response_with_string_time(self):
        """Test formatting success response with string time."""
        # Act
        response = self.tool._format_success_response(
            subscription_id=456,
            name="sub-test-xyz67890",
            display_name="Another Task",
            trigger_type="interval",
            trigger_config={"value": 1, "unit": "hours"},
            next_execution_time="2025-01-21T10:00:00",
            preserve_history=False,
        )

        # Assert
        result = json.loads(response)
        assert result["success"] is True
        assert result["subscription"]["next_execution_time"] == "2025-01-21T10:00:00"

    def test_format_success_response_management_url(self):
        """Test that management URL is included in response."""
        # Act
        response = self.tool._format_success_response(
            subscription_id=789,
            name="sub-test",
            display_name="Test",
            trigger_type="cron",
            trigger_config={},
            next_execution_time=None,
            preserve_history=False,
        )

        # Assert
        result = json.loads(response)
        assert result["management_url"] == "/subscriptions/789"


class TestCreateSubscriptionToolAsyncExecution:
    """Tests for CreateSubscriptionTool async execution."""

    def setup_method(self):
        """Set up test fixtures."""
        self.tool = CreateSubscriptionTool(
            user_id=1,
            team_id=10,
            team_name="test-team",
            team_namespace="default",
            timezone="Asia/Shanghai",
        )

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
            cron_expression="invalid",  # Invalid cron expression
        )

        # Assert
        response = json.loads(result)
        assert response["success"] is False
        assert "Invalid cron expression" in response["error"]

    @pytest.mark.asyncio
    async def test_arun_returns_error_for_missing_interval_config(self):
        """Test that _arun returns error when interval config is incomplete."""
        # Act
        result = await self.tool._arun(
            display_name="Test",
            trigger_type="interval",
            prompt_template="Test",
            interval_value=None,  # Missing value
        )

        # Assert
        response = json.loads(result)
        assert response["success"] is False
        assert "interval_value is required" in response["error"]


class TestCreateSubscriptionToolBackendMode:
    """Tests for CreateSubscriptionTool backend (package) mode."""

    def setup_method(self):
        """Set up test fixtures."""
        self.tool = CreateSubscriptionTool(
            user_id=1,
            team_id=10,
            team_name="test-team",
            team_namespace="default",
            timezone="Asia/Shanghai",
        )

    @pytest.mark.asyncio
    async def test_create_via_backend_success(self):
        """Test successful subscription creation via backend service."""
        # Arrange
        mock_result = MagicMock()
        mock_result.id = 123
        mock_result.name = "sub-test-abc12345"
        mock_result.display_name = "Test Task"
        mock_result.next_execution_time = datetime(2025, 1, 21, 9, 0, 0)

        mock_service = MagicMock()
        mock_service.create_subscription.return_value = mock_result

        mock_db = MagicMock()
        mock_session_local = MagicMock(return_value=mock_db)

        # Mock imports at the module level where they're imported
        with patch.dict(
            "sys.modules",
            {
                "app.db.session": MagicMock(SessionLocal=mock_session_local),
                "app.schemas.subscription": MagicMock(
                    SubscriptionCreate=MagicMock(return_value=MagicMock()),
                    SubscriptionTaskType=MagicMock(COLLECTION="collection"),
                ),
                "app.services.subscription.service": MagicMock(
                    subscription_service=mock_service
                ),
            },
        ):
            # Act
            result = await self.tool._create_via_backend(
                name="sub-test-abc12345",
                display_name="Test Task",
                description="Test description",
                trigger_type="cron",
                trigger_config={"expression": "0 9 * * *", "timezone": "UTC"},
                prompt_template="Generate report for {{date}}",
                preserve_history=False,
                history_message_count=10,
                retry_count=1,
                timeout_seconds=600,
            )

        # Assert
        response = json.loads(result)
        assert response["success"] is True
        assert response["subscription"]["id"] == 123

    @pytest.mark.asyncio
    async def test_create_via_backend_error_handling(self):
        """Test error handling when backend service fails."""
        # Arrange
        mock_db = MagicMock()
        mock_session_local = MagicMock(return_value=mock_db)

        mock_service = MagicMock()
        mock_service.create_subscription.side_effect = Exception("DB error")

        # Mock imports at the module level where they're imported
        with patch.dict(
            "sys.modules",
            {
                "app.db.session": MagicMock(SessionLocal=mock_session_local),
                "app.schemas.subscription": MagicMock(
                    SubscriptionCreate=MagicMock(return_value=MagicMock()),
                    SubscriptionTaskType=MagicMock(COLLECTION="collection"),
                ),
                "app.services.subscription.service": MagicMock(
                    subscription_service=mock_service
                ),
            },
        ):
            # Act
            result = await self.tool._create_via_backend(
                name="sub-test",
                display_name="Test",
                description=None,
                trigger_type="cron",
                trigger_config={"expression": "0 9 * * *"},
                prompt_template="Test",
                preserve_history=False,
                history_message_count=10,
                retry_count=1,
                timeout_seconds=600,
            )

        # Assert
        response = json.loads(result)
        assert response["success"] is False
        assert "DB error" in response["error"]


class TestCreateSubscriptionToolHttpMode:
    """Tests for CreateSubscriptionTool HTTP mode."""

    def setup_method(self):
        """Set up test fixtures."""
        self.tool = CreateSubscriptionTool(
            user_id=1,
            team_id=10,
            team_name="test-team",
            team_namespace="default",
            timezone="Asia/Shanghai",
            backend_url="http://localhost:8000",
        )

    @pytest.mark.asyncio
    async def test_create_via_http_missing_backend_url(self):
        """Test error when backend URL is not configured."""
        # Arrange
        tool = CreateSubscriptionTool(
            user_id=1,
            team_id=10,
            team_name="test-team",
            team_namespace="default",
            timezone="Asia/Shanghai",
            backend_url=None,  # No backend URL
        )

        # Act
        result = await tool._create_via_http(
            name="sub-test",
            display_name="Test",
            description=None,
            trigger_type="cron",
            trigger_config={"expression": "0 9 * * *"},
            prompt_template="Test",
            preserve_history=False,
            history_message_count=10,
            retry_count=1,
            timeout_seconds=600,
        )

        # Assert
        response = json.loads(result)
        assert response["success"] is False
        assert "Backend URL not configured" in response["error"]

    @pytest.mark.asyncio
    async def test_create_via_http_success(self):
        """Test successful subscription creation via HTTP API."""
        # Arrange
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "id": 456,
            "name": "sub-test-xyz67890",
            "display_name": "HTTP Test",
            "next_execution_time": "2025-01-21T09:00:00",
        }

        with patch("httpx.AsyncClient") as mock_client:
            mock_client.return_value.__aenter__.return_value.post = AsyncMock(
                return_value=mock_response
            )

            # Act
            result = await self.tool._create_via_http(
                name="sub-test-xyz67890",
                display_name="HTTP Test",
                description=None,
                trigger_type="cron",
                trigger_config={"expression": "0 9 * * *", "timezone": "UTC"},
                prompt_template="Test",
                preserve_history=True,
                history_message_count=20,
                retry_count=2,
                timeout_seconds=1200,
            )

        # Assert
        response = json.loads(result)
        assert response["success"] is True
        assert response["subscription"]["id"] == 456

    @pytest.mark.asyncio
    async def test_create_via_http_api_error(self):
        """Test handling of API error response."""
        # Arrange
        mock_response = MagicMock()
        mock_response.status_code = 400
        mock_response.text = "Bad Request"
        mock_response.json.return_value = {"detail": "Team not found"}

        with patch("httpx.AsyncClient") as mock_client:
            mock_client.return_value.__aenter__.return_value.post = AsyncMock(
                return_value=mock_response
            )

            # Act
            result = await self.tool._create_via_http(
                name="sub-test",
                display_name="Test",
                description=None,
                trigger_type="cron",
                trigger_config={"expression": "0 9 * * *"},
                prompt_template="Test",
                preserve_history=False,
                history_message_count=10,
                retry_count=1,
                timeout_seconds=600,
            )

        # Assert
        response = json.loads(result)
        assert response["success"] is False
        assert "400" in response["error"]

    @pytest.mark.asyncio
    async def test_create_via_http_network_error(self):
        """Test handling of network errors."""
        # Arrange
        with patch("httpx.AsyncClient") as mock_client:
            mock_client.return_value.__aenter__.return_value.post = AsyncMock(
                side_effect=Exception("Connection refused")
            )

            # Act
            result = await self.tool._create_via_http(
                name="sub-test",
                display_name="Test",
                description=None,
                trigger_type="cron",
                trigger_config={"expression": "0 9 * * *"},
                prompt_template="Test",
                preserve_history=False,
                history_message_count=10,
                retry_count=1,
                timeout_seconds=600,
            )

        # Assert
        response = json.loads(result)
        assert response["success"] is False
        assert "Connection refused" in response["error"]


class TestCreateSubscriptionToolMetadata:
    """Tests for CreateSubscriptionTool metadata."""

    def test_tool_name(self):
        """Test tool name is correct."""
        # Arrange
        tool = CreateSubscriptionTool(
            user_id=1,
            team_id=10,
            team_name="test",
            team_namespace="default",
            timezone="UTC",
        )

        # Assert
        assert tool.name == "create_subscription"

    def test_tool_display_name(self):
        """Test tool display name is correct."""
        # Arrange
        tool = CreateSubscriptionTool(
            user_id=1,
            team_id=10,
            team_name="test",
            team_namespace="default",
            timezone="UTC",
        )

        # Assert
        assert tool.display_name == "创建订阅任务"

    def test_tool_args_schema(self):
        """Test tool args schema is correct."""
        # Arrange
        tool = CreateSubscriptionTool(
            user_id=1,
            team_id=10,
            team_name="test",
            team_namespace="default",
            timezone="UTC",
        )

        # Assert
        assert tool.args_schema == CreateSubscriptionInput
