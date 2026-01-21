# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import atexit
import logging
import warnings
from unittest.mock import MagicMock, Mock

import pytest


@pytest.fixture
def mock_anthropic_client(mocker):
    """Mock Anthropic API client"""
    mock_client = mocker.MagicMock()
    mock_client.messages.create.return_value = Mock(
        content=[Mock(text="Test response")],
        id="msg_test123",
        model="claude-3-5-sonnet-20241022",
        role="assistant",
    )
    return mock_client


@pytest.fixture
def mock_openai_client(mocker):
    """Mock OpenAI API client"""
    mock_client = mocker.MagicMock()
    mock_client.chat.completions.create.return_value = Mock(
        choices=[Mock(message=Mock(content="Test response"))],
        id="chatcmpl-test123",
        model="gpt-4",
    )
    return mock_client


@pytest.fixture
def mock_callback_client(mocker):
    """Mock callback HTTP client for agent responses"""
    mock_client = mocker.MagicMock()
    mock_client.post.return_value = Mock(status_code=200)
    return mock_client


@pytest.fixture(scope="session", autouse=True)
def suppress_resource_warnings():
    """Suppress ResourceWarning about unclosed sockets during test cleanup"""
    warnings.filterwarnings("ignore", category=ResourceWarning, message="unclosed.*")
    yield


@pytest.fixture(scope="session", autouse=True)
def cleanup_logging():
    """Clean up logging handlers and queue listeners at test session end"""
    yield

    # Stop all queue listeners to prevent daemon thread errors
    for logger_name in list(logging.Logger.manager.loggerDict.keys()):
        logger = logging.getLogger(logger_name)
        if hasattr(logger, "_queue_listener"):
            try:
                logger._queue_listener.stop()
            except Exception:
                pass

    # Shutdown logging to flush all handlers
    logging.shutdown()
