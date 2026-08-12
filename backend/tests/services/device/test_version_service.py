# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import asyncio
from unittest.mock import AsyncMock, Mock

import pytest

from app.core.cache import cache_manager
from app.services.device.version_checker import (
    GithubVersionChecker,
    RegistryVersionChecker,
    VersionInfo,
)
from app.services.device.version_service import (
    EXECUTOR_VERSION_CACHE_KEY,
    EXECUTOR_VERSION_FAILURE_CACHE_TTL,
    EXECUTOR_VERSION_UNAVAILABLE,
    ExecutorVersionService,
)


@pytest.mark.asyncio
async def test_cached_version_is_returned_without_refresh(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = ExecutorVersionService()
    checker = AsyncMock()
    service._checker = checker
    monkeypatch.setattr(
        cache_manager,
        "get",
        AsyncMock(return_value="1.2.3"),
    )

    result = await service.get_latest_version()

    assert result == "1.2.3"
    checker.get_latest_version.assert_not_awaited()
    assert service._refresh_task is None


@pytest.mark.asyncio
async def test_cache_miss_starts_one_background_refresh(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = ExecutorVersionService()
    refresh_started = asyncio.Event()
    release_refresh = asyncio.Event()
    cached_value = None

    async def get_cached_version(_key: str):
        return cached_value

    async def set_cached_version(key: str, value: str, expire: int) -> bool:
        nonlocal cached_value
        assert key == EXECUTOR_VERSION_CACHE_KEY
        assert expire == service._cache_ttl
        cached_value = value
        return True

    async def fetch_latest_version() -> VersionInfo:
        refresh_started.set()
        await release_refresh.wait()
        return VersionInfo(version="2.0.0", download_url="")

    checker = AsyncMock()
    checker.get_latest_version.side_effect = fetch_latest_version
    service._checker = checker
    monkeypatch.setattr(cache_manager, "get", get_cached_version)
    monkeypatch.setattr(cache_manager, "set", set_cached_version)

    first_result = await service.get_latest_version()
    await refresh_started.wait()
    second_result = await service.get_latest_version()

    assert first_result is None
    assert second_result is None
    checker.get_latest_version.assert_awaited_once()

    release_refresh.set()
    assert service._refresh_task is not None
    await service._refresh_task
    assert await service.get_latest_version() == "2.0.0"


@pytest.mark.asyncio
async def test_failed_refresh_is_cached_briefly(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = ExecutorVersionService()
    cached_value = None

    async def get_cached_version(_key: str):
        return cached_value

    async def set_cached_version(key: str, value: str, expire: int) -> bool:
        nonlocal cached_value
        assert key == EXECUTOR_VERSION_CACHE_KEY
        assert value == EXECUTOR_VERSION_UNAVAILABLE
        assert expire == EXECUTOR_VERSION_FAILURE_CACHE_TTL
        cached_value = value
        return True

    checker = AsyncMock()
    checker.get_latest_version.return_value = None
    service._checker = checker
    monkeypatch.setattr(cache_manager, "get", get_cached_version)
    monkeypatch.setattr(cache_manager, "set", set_cached_version)

    assert await service.get_latest_version() is None
    assert service._refresh_task is not None
    await service._refresh_task
    assert await service.get_latest_version() is None

    checker.get_latest_version.assert_awaited_once()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("checker", "payload", "expected_version"),
    [
        (
            GithubVersionChecker(),
            {"tag_name": "v3.1.4"},
            "3.1.4",
        ),
        (
            RegistryVersionChecker("https://registry.example.com"),
            {"version": "4.2.0", "url": "https://example.com/executor"},
            "4.2.0",
        ),
    ],
)
async def test_version_checker_runs_blocking_request_in_thread(
    checker,
    payload: dict,
    expected_version: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    response = Mock()
    response.json.return_value = payload
    session = Mock()
    session.get.return_value = response
    to_thread = AsyncMock(side_effect=lambda callback: callback())
    monkeypatch.setattr(
        "app.services.device.version_checker.traced_session",
        lambda: session,
    )
    monkeypatch.setattr(
        "app.services.device.version_checker.asyncio.to_thread",
        to_thread,
    )

    result = await checker.get_latest_version()

    assert result is not None
    assert result.version == expected_version
    to_thread.assert_awaited_once()
