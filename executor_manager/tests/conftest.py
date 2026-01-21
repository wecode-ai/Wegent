# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import os
import sys
from pathlib import Path
from unittest.mock import MagicMock, Mock

# Add parent directory to Python path to allow imports
project_root = Path(__file__).parent.parent.parent
sys.path.insert(0, str(project_root))


# =============================================================================
# Early Mock Setup (Before test collection)
# =============================================================================
# Mock Redis BEFORE any other imports to prevent blocking during module load.
# This is critical because some modules (like PubSubManager) create Redis
# connections in __init__ which would block if Redis is not available.


def _create_mock_redis():
    """Create a mock Redis client for testing."""
    mock = MagicMock()
    mock.ping.return_value = True
    mock.get.return_value = None
    mock.set.return_value = True
    mock.setex.return_value = True
    mock.hset.return_value = 1
    mock.hget.return_value = None
    mock.hgetall.return_value = {}
    mock.delete.return_value = 1
    mock.expire.return_value = True
    mock.publish.return_value = 1
    mock.zadd.return_value = 1
    mock.zrem.return_value = 1
    mock.zrange.return_value = []
    mock.zrangebyscore.return_value = []
    return mock


# Patch redis.from_url before any imports can use it
import redis

_original_redis_from_url = redis.from_url
_mock_redis_instance = _create_mock_redis()
redis.from_url = MagicMock(return_value=_mock_redis_instance)

# Also patch redis.asyncio
import redis.asyncio as aioredis

_original_aioredis_from_url = aioredis.from_url
aioredis.from_url = MagicMock(return_value=_mock_redis_instance)


import pytest


@pytest.fixture
def mock_docker_client(mocker):
    """Mock Docker SDK client"""
    mock_client = mocker.MagicMock()

    # Mock container object
    mock_container = mocker.MagicMock()
    mock_container.id = "test_container_id"
    mock_container.status = "running"
    mock_container.start.return_value = None
    mock_container.stop.return_value = None
    mock_container.remove.return_value = None

    mock_client.containers.create.return_value = mock_container
    mock_client.containers.get.return_value = mock_container
    mock_client.containers.list.return_value = [mock_container]

    return mock_client


@pytest.fixture
def mock_executor_config():
    """Mock executor configuration"""
    return {
        "image": "test/executor:latest",
        "cpu_limit": "1.0",
        "memory_limit": "512m",
        "network_mode": "bridge",
    }


# =============================================================================
# Redis Fixtures
# =============================================================================


@pytest.fixture
def mock_redis_client(mocker):
    """Mock synchronous Redis client for testing."""
    mock_client = mocker.MagicMock()
    mock_client.ping.return_value = True
    mock_client.get.return_value = None
    mock_client.set.return_value = True
    mock_client.setex.return_value = True
    mock_client.hset.return_value = 1
    mock_client.hget.return_value = None
    mock_client.hgetall.return_value = {}
    mock_client.delete.return_value = 1
    mock_client.expire.return_value = True
    mock_client.publish.return_value = 1
    mock_client.zadd.return_value = 1
    mock_client.zrem.return_value = 1
    mock_client.zrange.return_value = []
    mock_client.zrangebyscore.return_value = []
    return mock_client


@pytest.fixture
def mock_async_redis_client(mocker):
    """Mock asynchronous Redis client for testing."""
    mock_client = mocker.MagicMock()
    mock_client.ping = mocker.AsyncMock(return_value=True)
    mock_pubsub = mocker.MagicMock()
    mock_pubsub.subscribe = mocker.AsyncMock()
    mock_pubsub.unsubscribe = mocker.AsyncMock()
    mock_pubsub.close = mocker.AsyncMock()
    mock_client.pubsub.return_value = mock_pubsub
    return mock_client


# =============================================================================
# Sandbox & Execution Model Fixtures
# =============================================================================


@pytest.fixture
def sample_sandbox_metadata():
    """Sample sandbox metadata for testing."""
    return {
        "task_id": 12345,
        "subtask_id": 1,
        "workspace_ref": "workspace-123",
        "bot_config": {"shell_type": "claudecode", "env": {"API_KEY": "test-key"}},
    }


@pytest.fixture
def sample_sandbox(sample_sandbox_metadata):
    """Create a sample Sandbox instance for testing."""
    from executor_manager.models.sandbox import Sandbox, SandboxStatus

    return Sandbox(
        sandbox_id="12345",
        container_name="wegent-task-testuser-12345",
        shell_type="ClaudeCode",
        status=SandboxStatus.RUNNING,
        user_id=100,
        user_name="testuser",
        base_url="http://localhost:10001",
        created_at=1704067200.0,
        started_at=1704067210.0,
        last_activity_at=1704067200.0,
        expires_at=1704069000.0,
        metadata=sample_sandbox_metadata,
    )


@pytest.fixture
def sample_execution():
    """Create a sample Execution instance for testing."""
    from executor_manager.models.sandbox import Execution, ExecutionStatus

    return Execution(
        execution_id="exec-uuid-123",
        sandbox_id="12345",
        prompt="Run the test suite",
        status=ExecutionStatus.PENDING,
        created_at=1704067200.0,
        metadata={"task_id": 12345, "subtask_id": 1},
    )


# =============================================================================
# Task Fixtures
# =============================================================================


@pytest.fixture
def sample_sandbox_task():
    """Sample Sandbox task data for testing."""
    return {
        "task_id": 123,
        "subtask_id": 456,
        "task_prompt": "Execute the test suite",
        "shell_type": "ClaudeCode",
        "user_id": 100,
        "user_name": "testuser",
        "workspace_ref": "workspace-123",
        "timeout": 600,
        "bot_config": {"env": {"API_KEY": "test-key"}},
    }


# =============================================================================
# HTTP/httpx Fixtures
# =============================================================================


@pytest.fixture
def mock_httpx_response(mocker):
    """Factory for creating mock HTTP responses."""

    def _create_response(status_code=200, json_data=None, text=""):
        response = mocker.MagicMock()
        response.status_code = status_code
        response.json.return_value = json_data or {}
        response.text = text or str(json_data or {})
        return response

    return _create_response


@pytest.fixture
def mock_httpx_async_client(mocker, mock_httpx_response):
    """Mock httpx AsyncClient for testing HTTP requests."""
    mock_client = mocker.MagicMock()
    mock_response = mock_httpx_response(200, {"status": "success"})
    mock_client.__aenter__ = mocker.AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = mocker.AsyncMock(return_value=None)
    mock_client.post = mocker.AsyncMock(return_value=mock_response)
    mock_client.get = mocker.AsyncMock(return_value=mock_response)
    return mock_client


# =============================================================================
# HeartbeatManager Fixtures
# =============================================================================


@pytest.fixture
def mock_heartbeat_manager(mocker):
    """Mock HeartbeatManager for testing."""
    mock_manager = mocker.MagicMock()
    mock_manager.update_heartbeat.return_value = True
    mock_manager.check_heartbeat.return_value = True
    mock_manager.get_last_heartbeat.return_value = 1704067200.0
    mock_manager.delete_heartbeat.return_value = True
    return mock_manager


# =============================================================================
# Executor Fixtures
# =============================================================================


@pytest.fixture
def mock_executor_dispatcher(mocker):
    """Mock ExecutorDispatcher for testing."""
    mock_executor = mocker.MagicMock()
    mock_executor.submit_executor.return_value = {
        "status": "success",
        "executor_name": "test-executor-123",
    }
    return mock_executor


@pytest.fixture
def mock_task_processor(mocker):
    """Mock TaskProcessor for testing."""
    mock_processor = mocker.MagicMock()
    mock_processor._process_single_task.return_value = (
        {"status": "success", "executor_name": "test-executor"},
        True,
    )
    return mock_processor


# =============================================================================
# Singleton Reset Fixture
# =============================================================================


@pytest.fixture(autouse=True)
def reset_all_singletons_and_mock_redis(mocker, mock_redis_client):
    """Reset all singleton instances and mock Redis before each test.

    This fixture is autouse=True to ensure clean state for all tests.
    It mocks Redis connections to prevent blocking during tests.
    """
    # Mock Redis before any imports that might trigger connections
    mocker.patch(
        "executor_manager.common.redis_factory.redis.from_url",
        return_value=mock_redis_client,
    )
    mocker.patch("redis.from_url", return_value=mock_redis_client)

    # Reset singletons
    try:
        from executor_manager.common.singleton import SingletonMeta

        SingletonMeta.reset_all_instances()
    except ImportError:
        pass

    try:
        from executor_manager.common.redis_factory import RedisClientFactory

        RedisClientFactory.reset()
    except ImportError:
        pass

    try:
        from executor_manager.common.config import reset_config

        reset_config()
    except ImportError:
        pass

    try:
        from executor_manager.services.heartbeat_manager import HeartbeatManager

        HeartbeatManager._instance = None
    except ImportError:
        pass

    yield

    # Cleanup after test
    try:
        from executor_manager.common.singleton import SingletonMeta

        SingletonMeta.reset_all_instances()
    except ImportError:
        pass

    try:
        from executor_manager.common.redis_factory import RedisClientFactory

        RedisClientFactory.reset()
    except ImportError:
        pass

    try:
        from executor_manager.common.config import reset_config

        reset_config()
    except ImportError:
        pass

    try:
        from executor_manager.services.heartbeat_manager import HeartbeatManager

        HeartbeatManager._instance = None
    except ImportError:
        pass


@pytest.fixture(autouse=False)
def reset_service_singletons():
    """Reset singleton instances before and after test.

    Note: Not autouse - import explicitly when needed to avoid import errors.
    Deprecated: Use reset_all_singletons_and_mock_redis instead.
    """
    yield
    # Cleanup after test
    try:
        from executor_manager.common.singleton import SingletonMeta

        SingletonMeta.reset_all_instances()
    except ImportError:
        pass
    try:
        from executor_manager.services.heartbeat_manager import HeartbeatManager

        HeartbeatManager._instance = None
    except ImportError:
        pass


# =============================================================================
# Session-level Cleanup for QueueListener threads
# =============================================================================


def _stop_all_queue_listeners():
    """Stop all QueueListener threads to prevent shutdown errors.

    The shared/logger.py creates QueueListener threads for multiprocessing-safe
    logging. These threads need to be stopped before the test process exits.
    """
    import logging

    for name in list(logging.Logger.manager.loggerDict.keys()):
        logger = logging.getLogger(name)
        if hasattr(logger, "_queue_listener") and logger._queue_listener is not None:
            try:
                logger._queue_listener.stop()
                logger._queue_listener = None
            except Exception:
                pass


@pytest.fixture(scope="session", autouse=True)
def cleanup_queue_listeners_at_session_end():
    """Cleanup QueueListener threads at the end of the test session."""
    yield
    _stop_all_queue_listeners()


# Also register an atexit handler as a fallback
import atexit

atexit.register(_stop_all_queue_listeners)
