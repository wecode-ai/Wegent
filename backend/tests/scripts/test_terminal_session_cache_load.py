# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import argparse
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from scripts import terminal_session_cache_load
from scripts.terminal_session_cache_load import (
    command_delta,
    percentile,
    redis_counter_failures,
    validate_args,
    wait_for_revocation,
)


def make_args(**overrides: int | float) -> argparse.Namespace:
    values: dict[str, int | float] = {
        "instances": 3,
        "sessions": 1000,
        "rounds": 10,
        "cache_entries": 8192,
        "concurrency": 64,
        "revocations": 100,
        "ttl_seconds": 300,
        "invalidation_timeout_ms": 2000,
        "max_invalidation_p95_ms": 250,
    }
    values.update(overrides)
    return argparse.Namespace(**values)


def test_validate_args_accepts_observable_over_capacity_scenario() -> None:
    validate_args(
        make_args(
            instances=2,
            sessions=17,
            cache_entries=8,
            revocations=0,
        )
    )


def test_validate_args_rejects_invalid_revocation_count() -> None:
    with pytest.raises(ValueError, match="revocations"):
        validate_args(make_args(sessions=10, revocations=11))


def test_percentile_uses_nearest_rank() -> None:
    values = [1.0, 4.0, 2.0, 3.0]

    assert percentile(values, 0.50) == 2.0
    assert percentile(values, 0.95) == 4.0


def test_command_delta_never_reports_negative_counts() -> None:
    before = {"scan": 7, "keys": 3}
    after = {"scan": 6, "keys": 4}

    assert command_delta(before, after) == {
        "eval": 0,
        "get": 0,
        "set": 0,
        "publish": 0,
        "scan": 0,
        "keys": 1,
    }


def test_redis_counter_failures_enforces_isolated_server_counters() -> None:
    failures = redis_counter_failures(
        "isolated",
        {"scan": 1, "keys": 2},
        rejected_connections=3,
    )

    assert failures == [
        "Redis commandstats observed forbidden SCAN/KEYS commands",
        "Redis rejected 3 connections during the load",
    ]


def test_shared_redis_server_counters_are_informational() -> None:
    assert (
        redis_counter_failures(
            "shared",
            {"scan": 1, "keys": 2},
            rejected_connections=3,
        )
        == []
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("revoked", [True, False])
async def test_wait_for_revocation_requires_every_instance(monkeypatch, revoked):
    first = SimpleNamespace(is_revoked=Mock(return_value=True))
    second = SimpleNamespace(is_revoked=Mock(side_effect=[False, revoked]))
    clock = SimpleNamespace(perf_counter=Mock(side_effect=[0.0, 0.0, 0.5, 1.0]))
    monkeypatch.setattr(terminal_session_cache_load, "time", clock)
    sleep = AsyncMock()
    monkeypatch.setattr(
        terminal_session_cache_load, "asyncio", SimpleNamespace(sleep=sleep)
    )

    if revoked:
        await wait_for_revocation([first, second], "terminal-1", 1.0)
    else:
        with pytest.raises(TimeoutError, match="not invalidated on every Backend"):
            await wait_for_revocation([first, second], "terminal-1", 1.0)

    assert first.is_revoked.call_count == second.is_revoked.call_count == 2
    second.is_revoked.assert_called_with("terminal-1")
    assert sleep.await_count == (1 if revoked else 2)
