# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Unit tests for deployment-scoped sandbox persistence."""

from unittest.mock import AsyncMock

import pytest

from executor_manager.common.config import reset_config
from executor_manager.common.singleton import SingletonMeta
from executor_manager.services.sandbox.repository import (
    LEGACY_ACTIVE_SANDBOXES_ZSET,
    SandboxRepository,
    _build_active_sandboxes_zset,
)


@pytest.fixture(autouse=True)
def reset_repository_state(monkeypatch):
    """Reset singleton and environment-derived configuration for each test."""
    for env_name in (
        "SANDBOX_MANAGER_SCOPE",
        "EXECUTOR_MANAGER_HEARTBEAT_BASE_URL",
        "EXECUTOR_MANAGER_URL",
        "EXECUTOR_MANAGER_CALLBACK_URL",
        "SERVICE_POOL",
    ):
        monkeypatch.delenv(env_name, raising=False)
    reset_config()
    SingletonMeta.reset_all_instances()
    yield
    reset_config()
    SingletonMeta.reset_all_instances()


def _create_repository(mocker, mock_redis_client) -> SandboxRepository:
    mocker.patch(
        "executor_manager.services.sandbox.repository."
        "RedisClientFactory.get_sync_client",
        return_value=mock_redis_client,
    )
    return SandboxRepository()


def test_manager_scope_prefers_explicit_configuration(
    monkeypatch, mocker, mock_redis_client
):
    """An explicit manager scope must override URL-derived defaults."""
    monkeypatch.setenv("SANDBOX_MANAGER_SCOPE", "simulation-manager")
    monkeypatch.setenv(
        "EXECUTOR_MANAGER_HEARTBEAT_BASE_URL", "http://production-manager"
    )

    repository = _create_repository(mocker, mock_redis_client)

    assert repository.active_sandboxes_zset == _build_active_sandboxes_zset(
        "simulation-manager"
    )


def test_manager_scope_uses_stable_heartbeat_url(
    monkeypatch, mocker, mock_redis_client
):
    """Replicas with the same callback URL must share one active index."""
    heartbeat_url = "http://simulation-executor-manager/executor-manager"
    monkeypatch.setenv("EXECUTOR_MANAGER_HEARTBEAT_BASE_URL", heartbeat_url)

    repository = _create_repository(mocker, mock_redis_client)

    assert repository.active_sandboxes_zset == _build_active_sandboxes_zset(
        heartbeat_url
    )
    assert repository.active_sandboxes_zset != LEGACY_ACTIVE_SANDBOXES_ZSET


def test_save_sandbox_migrates_legacy_active_membership(
    monkeypatch, mocker, mock_redis_client, sample_sandbox
):
    """Saving must hide the sandbox from old managers scanning the global index."""
    monkeypatch.setenv("SANDBOX_MANAGER_SCOPE", "simulation-manager")
    repository = _create_repository(mocker, mock_redis_client)

    assert repository.save_sandbox(sample_sandbox) is True

    mock_redis_client.zrem.assert_called_with(LEGACY_ACTIVE_SANDBOXES_ZSET, "12345")
    mock_redis_client.zadd.assert_called_once()
    assert mock_redis_client.zadd.call_args.args[0] == repository.active_sandboxes_zset


def test_get_active_sandbox_ids_reads_only_owned_index(
    monkeypatch, mocker, mock_redis_client
):
    """Lifecycle scans must not enumerate sandboxes owned by another deployment."""
    monkeypatch.setenv("SANDBOX_MANAGER_SCOPE", "simulation-manager")
    mock_redis_client.zrange.return_value = ["12345"]
    repository = _create_repository(mocker, mock_redis_client)

    assert repository.get_active_sandbox_ids() == ["12345"]

    mock_redis_client.zrange.assert_called_once_with(
        repository.active_sandboxes_zset, 0, -1
    )


@pytest.mark.asyncio
async def test_get_active_sandbox_ids_async_reads_only_owned_index(
    monkeypatch, mocker, mock_redis_client
):
    """Async heartbeat scans must use the same deployment-scoped index."""
    monkeypatch.setenv("SANDBOX_MANAGER_SCOPE", "simulation-manager")
    repository = _create_repository(mocker, mock_redis_client)
    async_client = mocker.MagicMock()
    async_client.zrange = AsyncMock(return_value=["12345"])
    repository._async_redis_client = async_client

    assert await repository.get_active_sandbox_ids_async() == ["12345"]

    async_client.zrange.assert_awaited_once_with(
        repository.active_sandboxes_zset, 0, -1
    )
