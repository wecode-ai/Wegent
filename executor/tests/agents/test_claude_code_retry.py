#!/usr/bin/env python
# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

"""
Tests for Claude Code Agent retry functionality
"""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch, call
from dataclasses import dataclass

from executor.agents.claude_code.response_processor import process_response
from shared.status import TaskStatus
from claude_agent_sdk.types import ResultMessage, AssistantMessage, TextBlock


@dataclass
class MockResultMessage:
    """Mock ResultMessage for testing"""
    subtype: str
    is_error: bool
    session_id: str
    num_turns: int
    duration_ms: int
    duration_api_ms: int
    total_cost_usd: float
    usage: dict
    result: str
    parent_tool_use_id: str = None


@pytest.fixture
def mock_client():
    """Create a mock Claude SDK client"""
    client = AsyncMock()
    client.query = AsyncMock()
    return client


@pytest.fixture
def mock_state_manager():
    """Create a mock state manager"""
    state_manager = MagicMock()
    state_manager.report_progress = MagicMock()
    state_manager.update_workbench_status = MagicMock()
    return state_manager


@pytest.fixture
def mock_thinking_manager():
    """Create a mock thinking manager"""
    thinking_manager = MagicMock()
    thinking_manager.add_thinking_step = MagicMock()
    thinking_manager.add_thinking_step_by_key = MagicMock()
    return thinking_manager


@pytest.mark.asyncio
async def test_retry_on_cannot_read_properties_error(
    mock_client, mock_state_manager, mock_thinking_manager
):
    """Test that retry is triggered when encountering 'Cannot read properties of undefined' error"""
    
    # Create error message followed by success message
    error_msg = MockResultMessage(
        subtype="success",
        is_error=True,
        session_id="test-session",
        num_turns=1,
        duration_ms=1000,
        duration_api_ms=900,
        total_cost_usd=0.01,
        usage={},
        result="API Error: Cannot read properties of undefined (reading 'map')"
    )
    
    success_msg = MockResultMessage(
        subtype="success",
        is_error=False,
        session_id="test-session",
        num_turns=2,
        duration_ms=2000,
        duration_api_ms=1800,
        total_cost_usd=0.02,
        usage={},
        result="Task completed successfully"
    )
    
    # Mock receive_response to return error then success after retry
    messages = [error_msg, success_msg]
    mock_client.receive_response = AsyncMock()
    mock_client.receive_response.return_value.__aiter__ = AsyncMock(return_value=iter(messages))
    
    # Call process_response
    result = await process_response(
        mock_client,
        mock_state_manager,
        mock_thinking_manager,
        session_id="test-session"
    )
    
    # Verify that retry message was sent
    mock_client.query.assert_called_once_with("继续", session_id="test-session")
    
    # Verify final status is COMPLETED
    assert result == TaskStatus.COMPLETED
    
    # Verify thinking step was added for retry
    mock_thinking_manager.add_thinking_step.assert_any_call(
        title="thinking.auto_retry_attempt",
        report_immediately=True,
        use_i18n_keys=True,
        details={
            "retry_count": 1,
            "max_retries": 10,
            "error_message": "API Error: Cannot read properties of undefined (reading 'map')"
        }
    )


@pytest.mark.asyncio
async def test_max_retry_limit_reached(
    mock_client, mock_state_manager, mock_thinking_manager
):
    """Test that task fails after reaching max retry limit"""
    
    # Create 11 error messages (exceeding max_retries of 10)
    error_msg = MockResultMessage(
        subtype="success",
        is_error=True,
        session_id="test-session",
        num_turns=1,
        duration_ms=1000,
        duration_api_ms=900,
        total_cost_usd=0.01,
        usage={},
        result="Cannot read properties of undefined"
    )
    
    messages = [error_msg] * 11
    mock_client.receive_response = AsyncMock()
    mock_client.receive_response.return_value.__aiter__ = AsyncMock(return_value=iter(messages))
    
    # Call process_response
    result = await process_response(
        mock_client,
        mock_state_manager,
        mock_thinking_manager,
        session_id="test-session"
    )
    
    # Verify that retry was attempted 10 times
    assert mock_client.query.call_count == 10
    
    # Verify final status is FAILED
    assert result == TaskStatus.FAILED
    
    # Verify max retry limit thinking step was added
    mock_thinking_manager.add_thinking_step.assert_any_call(
        title="thinking.max_retry_limit_reached",
        report_immediately=True,
        use_i18n_keys=True,
        details={
            "retry_count": 10,
            "max_retries": 10,
            "error_message": "Cannot read properties of undefined"
        }
    )


@pytest.mark.asyncio
async def test_no_retry_on_non_matching_error(
    mock_client, mock_state_manager, mock_thinking_manager
):
    """Test that retry is not triggered for errors that don't match retry patterns"""
    
    # Create error message with non-matching pattern
    error_msg = MockResultMessage(
        subtype="success",
        is_error=True,
        session_id="test-session",
        num_turns=1,
        duration_ms=1000,
        duration_api_ms=900,
        total_cost_usd=0.01,
        usage={},
        result="API Error: Some other error message"
    )
    
    messages = [error_msg]
    mock_client.receive_response = AsyncMock()
    mock_client.receive_response.return_value.__aiter__ = AsyncMock(return_value=iter(messages))
    
    # Call process_response
    result = await process_response(
        mock_client,
        mock_state_manager,
        mock_thinking_manager,
        session_id="test-session"
    )
    
    # Verify that no retry was attempted
    mock_client.query.assert_not_called()
    
    # Verify final status is FAILED
    assert result == TaskStatus.FAILED


@pytest.mark.asyncio
async def test_retry_without_session_id(
    mock_client, mock_state_manager, mock_thinking_manager
):
    """Test that retry is not attempted when session_id is not provided"""
    
    error_msg = MockResultMessage(
        subtype="success",
        is_error=True,
        session_id="test-session",
        num_turns=1,
        duration_ms=1000,
        duration_api_ms=900,
        total_cost_usd=0.01,
        usage={},
        result="Cannot read properties of undefined"
    )
    
    messages = [error_msg]
    mock_client.receive_response = AsyncMock()
    mock_client.receive_response.return_value.__aiter__ = AsyncMock(return_value=iter(messages))
    
    # Call process_response without session_id
    result = await process_response(
        mock_client,
        mock_state_manager,
        mock_thinking_manager,
        session_id=None
    )
    
    # Verify that no retry was attempted
    mock_client.query.assert_not_called()
    
    # Verify final status is FAILED
    assert result == TaskStatus.FAILED


@pytest.mark.asyncio
async def test_retry_with_reference_error(
    mock_client, mock_state_manager, mock_thinking_manager
):
    """Test that retry is triggered for ReferenceError pattern"""
    
    error_msg = MockResultMessage(
        subtype="success",
        is_error=True,
        session_id="test-session",
        num_turns=1,
        duration_ms=1000,
        duration_api_ms=900,
        total_cost_usd=0.01,
        usage={},
        result="ReferenceError: variable is not defined"
    )
    
    success_msg = MockResultMessage(
        subtype="success",
        is_error=False,
        session_id="test-session",
        num_turns=2,
        duration_ms=2000,
        duration_api_ms=1800,
        total_cost_usd=0.02,
        usage={},
        result="Task completed"
    )
    
    messages = [error_msg, success_msg]
    mock_client.receive_response = AsyncMock()
    mock_client.receive_response.return_value.__aiter__ = AsyncMock(return_value=iter(messages))
    
    # Call process_response
    result = await process_response(
        mock_client,
        mock_state_manager,
        mock_thinking_manager,
        session_id="test-session"
    )
    
    # Verify that retry message was sent
    mock_client.query.assert_called_once_with("继续", session_id="test-session")
    
    # Verify final status is COMPLETED
    assert result == TaskStatus.COMPLETED


@pytest.mark.asyncio
async def test_successful_execution_without_errors(
    mock_client, mock_state_manager, mock_thinking_manager
):
    """Test normal successful execution without any errors"""
    
    success_msg = MockResultMessage(
        subtype="success",
        is_error=False,
        session_id="test-session",
        num_turns=1,
        duration_ms=1000,
        duration_api_ms=900,
        total_cost_usd=0.01,
        usage={},
        result="Task completed successfully"
    )
    
    messages = [success_msg]
    mock_client.receive_response = AsyncMock()
    mock_client.receive_response.return_value.__aiter__ = AsyncMock(return_value=iter(messages))
    
    # Call process_response
    result = await process_response(
        mock_client,
        mock_state_manager,
        mock_thinking_manager,
        session_id="test-session"
    )
    
    # Verify that no retry was attempted
    mock_client.query.assert_not_called()
    
    # Verify final status is COMPLETED
    assert result == TaskStatus.COMPLETED
    
    # Verify success was reported
    mock_state_manager.report_progress.assert_called()
    mock_state_manager.update_workbench_status.assert_called_with("completed")
