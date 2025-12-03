# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Unit tests for SSE (Server-Sent Events) schemas
"""
import pytest
from datetime import datetime

from app.schemas.sse import (
    SSEEvent,
    SSEEventType,
    WorkflowStartedData,
    NodeStartedData,
    NodeFinishedData,
    WorkflowFinishedData,
    StreamTaskCreate,
    TeamParameter,
    TeamParametersResponse,
)


class TestSSEEventType:
    """Test SSE event type enum"""

    def test_event_types_exist(self):
        """Test all required event types are defined"""
        assert SSEEventType.WORKFLOW_STARTED.value == "workflow_started"
        assert SSEEventType.NODE_STARTED.value == "node_started"
        assert SSEEventType.NODE_FINISHED.value == "node_finished"
        assert SSEEventType.WORKFLOW_FINISHED.value == "workflow_finished"
        assert SSEEventType.ERROR.value == "error"
        assert SSEEventType.PING.value == "ping"


class TestWorkflowStartedData:
    """Test WorkflowStartedData schema"""

    def test_create_workflow_started_data(self):
        """Test creating workflow started data"""
        now = datetime.now()
        data = WorkflowStartedData(
            task_id=123,
            workflow_run_id="run_123_1234567890",
            created_at=now,
        )

        assert data.task_id == 123
        assert data.workflow_run_id == "run_123_1234567890"
        assert data.created_at == now


class TestNodeStartedData:
    """Test NodeStartedData schema"""

    def test_create_node_started_data(self):
        """Test creating node started data"""
        data = NodeStartedData(
            node_id="1",
            node_type="bot",
            title="Code Analysis Bot",
            bot_name="analyzer",
            index=0,
        )

        assert data.node_id == "1"
        assert data.node_type == "bot"
        assert data.title == "Code Analysis Bot"
        assert data.bot_name == "analyzer"
        assert data.index == 0

    def test_node_started_data_optional_fields(self):
        """Test node started data with optional fields"""
        data = NodeStartedData(
            node_id="2",
            title="Bot 2",
        )

        assert data.node_id == "2"
        assert data.node_type == "bot"
        assert data.bot_name is None
        assert data.index is None


class TestNodeFinishedData:
    """Test NodeFinishedData schema"""

    def test_create_node_finished_data_success(self):
        """Test creating successful node finished data"""
        data = NodeFinishedData(
            node_id="1",
            status="succeeded",
            outputs={"result": "analysis complete"},
            execution_metadata={"progress": 100},
        )

        assert data.node_id == "1"
        assert data.status == "succeeded"
        assert data.outputs == {"result": "analysis complete"}
        assert data.error_message is None

    def test_create_node_finished_data_failed(self):
        """Test creating failed node finished data"""
        data = NodeFinishedData(
            node_id="1",
            status="failed",
            error_message="Execution timeout",
        )

        assert data.node_id == "1"
        assert data.status == "failed"
        assert data.error_message == "Execution timeout"
        assert data.outputs is None


class TestWorkflowFinishedData:
    """Test WorkflowFinishedData schema"""

    def test_create_workflow_finished_data(self):
        """Test creating workflow finished data"""
        data = WorkflowFinishedData(
            status="succeeded",
            outputs={"final_report": "Task completed"},
            total_tokens=1500,
            total_steps=3,
            elapsed_time=45.5,
        )

        assert data.status == "succeeded"
        assert data.outputs == {"final_report": "Task completed"}
        assert data.total_tokens == 1500
        assert data.total_steps == 3
        assert data.elapsed_time == 45.5


class TestSSEEvent:
    """Test SSE event generation"""

    def test_create_sse_event(self):
        """Test creating SSE event"""
        event = SSEEvent(
            event=SSEEventType.WORKFLOW_STARTED,
            task_id=123,
            data={"task_id": 123, "workflow_run_id": "run_123"},
        )

        assert event.event == SSEEventType.WORKFLOW_STARTED
        assert event.task_id == 123
        assert event.data is not None

    def test_sse_event_to_sse_format(self):
        """Test converting SSE event to SSE format string"""
        event = SSEEvent(
            event=SSEEventType.WORKFLOW_STARTED,
            task_id=123,
            data={"test": "data"},
        )

        sse_string = event.to_sse_format()

        assert sse_string.startswith("data: ")
        assert sse_string.endswith("\n\n")
        assert '"event": "workflow_started"' in sse_string
        assert '"task_id": 123' in sse_string

    def test_sse_event_with_message(self):
        """Test SSE event with error message"""
        event = SSEEvent(
            event=SSEEventType.ERROR,
            task_id=456,
            message="Task execution failed",
        )

        sse_string = event.to_sse_format()

        assert '"event": "error"' in sse_string
        assert '"message": "Task execution failed"' in sse_string


class TestStreamTaskCreate:
    """Test StreamTaskCreate schema"""

    def test_create_stream_task_minimal(self):
        """Test creating stream task with minimal fields"""
        task = StreamTaskCreate(
            team_id=1,
            prompt="Analyze the code",
        )

        assert task.team_id == 1
        assert task.prompt == "Analyze the code"
        assert task.type == "online"
        assert task.task_type == "chat"
        assert task.force_override_bot_model is False

    def test_create_stream_task_full(self):
        """Test creating stream task with all fields"""
        task = StreamTaskCreate(
            team_id=5,
            team_name="Code Review Team",
            team_namespace="default",
            prompt="Review security issues",
            title="Security Audit",
            type="offline",
            task_type="code",
            inputs={"file_path": "src/main.py"},
            model_id="gpt-4",
            force_override_bot_model=True,
            git_url="https://github.com/example/repo",
            git_repo="example/repo",
            branch_name="main",
        )

        assert task.team_id == 5
        assert task.team_name == "Code Review Team"
        assert task.prompt == "Review security issues"
        assert task.inputs == {"file_path": "src/main.py"}
        assert task.model_id == "gpt-4"
        assert task.force_override_bot_model is True


class TestTeamParameter:
    """Test TeamParameter schema"""

    def test_create_text_parameter(self):
        """Test creating text parameter"""
        param = TeamParameter(
            name="code_file",
            type="string",
            required=True,
            description="Path to code file",
        )

        assert param.name == "code_file"
        assert param.type == "string"
        assert param.required is True

    def test_create_select_parameter(self):
        """Test creating select parameter"""
        param = TeamParameter(
            name="language",
            type="select",
            required=False,
            options=["python", "javascript", "go"],
            default="python",
        )

        assert param.name == "language"
        assert param.type == "select"
        assert param.options == ["python", "javascript", "go"]
        assert param.default == "python"


class TestTeamParametersResponse:
    """Test TeamParametersResponse schema"""

    def test_empty_parameters(self):
        """Test response with no parameters"""
        response = TeamParametersResponse()

        assert response.parameters == []
        assert response.has_parameters is False

    def test_with_parameters(self):
        """Test response with parameters"""
        params = [
            TeamParameter(name="input1", type="string"),
            TeamParameter(name="input2", type="number"),
        ]
        response = TeamParametersResponse(
            parameters=params,
            has_parameters=True,
            app_mode="workflow",
        )

        assert len(response.parameters) == 2
        assert response.has_parameters is True
        assert response.app_mode == "workflow"
