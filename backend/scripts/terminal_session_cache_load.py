# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Load-test terminal session caching against a real shared Redis."""

import argparse
import asyncio
import json
import math
import shutil
import socket
import subprocess
import tempfile
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable, Iterable, Optional, TypeVar

from redis.asyncio import Redis

from app.services.device.terminal_session_record import TerminalSessionRecord
from app.services.device.terminal_session_service import (
    TERMINAL_SESSION_KEY_PREFIX,
    RedisTerminalSessionClientProvider,
    RedisTerminalSessionInvalidationListener,
    RedisTerminalSessionStore,
    TerminalSessionService,
)

Item = TypeVar("Item")
Operation = Callable[[Item], Awaitable[None]]
RedisClientFactory = Callable[[], Awaitable[Redis]]
COMMANDS = ("eval", "get", "set", "publish", "scan", "keys")


class IsolatedRedis:
    """Own one temporary Redis process without inspecting existing databases."""

    def __init__(self) -> None:
        self.url = ""
        self._process: Optional[subprocess.Popen] = None
        self._directory: Optional[tempfile.TemporaryDirectory] = None

    async def start(self) -> str:
        command = shutil.which("redis-server")
        if command is None:
            raise RuntimeError(
                "redis-server is required, or pass --redis-url for an existing Redis"
            )
        port = _available_local_port()
        self.url = f"redis://127.0.0.1:{port}/0"
        self._directory = tempfile.TemporaryDirectory(prefix="work402-redis-")
        self._process = subprocess.Popen(
            [
                command,
                "--bind",
                "127.0.0.1",
                "--protected-mode",
                "yes",
                "--port",
                str(port),
                "--save",
                "",
                "--appendonly",
                "no",
                "--daemonize",
                "no",
                "--dir",
                self._directory.name,
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if self._process.poll() is not None:
                raise RuntimeError("isolated redis-server exited during startup")
            try:
                await assert_redis_available(self.url)
                return self.url
            except Exception:
                await asyncio.sleep(0.02)
        raise RuntimeError("isolated redis-server did not become ready")

    async def stop(self) -> None:
        process = self._process
        self._process = None
        if process is not None and process.poll() is None:
            process.terminate()
            try:
                await asyncio.to_thread(process.wait, 5)
            except subprocess.TimeoutExpired:
                process.kill()
                await asyncio.to_thread(process.wait)
        if self._directory is not None:
            self._directory.cleanup()
            self._directory = None


class CountingRedisTerminalSessionStore(RedisTerminalSessionStore):
    """Run the production Redis store while counting exact-key reads."""

    def __init__(self, client_factory: RedisClientFactory) -> None:
        super().__init__(client_factory)
        self.gets = 0

    async def get(self, session_id: str) -> TerminalSessionRecord | None:
        self.gets += 1
        return await super().get(session_id)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Exercise the production terminal session store/cache with multiple "
            "Backend instances. Only exact Redis keys are touched."
        )
    )
    parser.add_argument(
        "--redis-url",
        help=(
            "Use an existing shared Redis. Omit this option to start a temporary "
            "isolated local redis-server."
        ),
    )
    parser.add_argument("--instances", type=int, default=3)
    parser.add_argument("--sessions", type=int, default=1000)
    parser.add_argument("--rounds", type=int, default=10)
    parser.add_argument("--cache-entries", type=int, default=8192)
    parser.add_argument("--concurrency", type=int, default=64)
    parser.add_argument("--revocations", type=int, default=100)
    parser.add_argument("--ttl-seconds", type=int, default=300)
    parser.add_argument("--invalidation-timeout-ms", type=float, default=2000)
    parser.add_argument("--max-invalidation-p95-ms", type=float, default=250)
    return parser.parse_args()


def validate_args(args: argparse.Namespace) -> None:
    positive_values = {
        "instances": args.instances,
        "sessions": args.sessions,
        "rounds": args.rounds,
        "cache_entries": args.cache_entries,
        "concurrency": args.concurrency,
        "ttl_seconds": args.ttl_seconds,
        "invalidation_timeout_ms": args.invalidation_timeout_ms,
        "max_invalidation_p95_ms": args.max_invalidation_p95_ms,
    }
    invalid = [name for name, value in positive_values.items() if value <= 0]
    if invalid:
        raise ValueError(f"{', '.join(invalid)} must be greater than zero")
    if args.revocations < 0 or args.revocations > args.sessions:
        raise ValueError("revocations must be between zero and sessions")


async def run_bounded(
    items: Iterable[Item],
    concurrency: int,
    operation: Operation[Item],
) -> None:
    iterator = iter(items)

    async def worker() -> None:
        while True:
            try:
                item = next(iterator)
            except StopIteration:
                return
            await operation(item)

    await asyncio.gather(*(worker() for _ in range(concurrency)))


async def redis_snapshot(redis_url: str) -> dict[str, Any]:
    client = Redis.from_url(redis_url, decode_responses=False)
    try:
        command_info = await client.info("commandstats")
        stats_info = await client.info("stats")
        client_info = await client.info("clients")
    finally:
        await client.aclose()
    return {
        "commands": {
            command: int(command_info.get(f"cmdstat_{command}", {}).get("calls", 0))
            for command in COMMANDS
        },
        "total_connections_received": int(
            stats_info.get("total_connections_received", 0)
        ),
        "rejected_connections": int(stats_info.get("rejected_connections", 0)),
        "connected_clients": int(client_info.get("connected_clients", 0)),
        "maxclients": int(client_info.get("maxclients", 0)),
    }


def command_delta(
    before: dict[str, int],
    after: dict[str, int],
) -> dict[str, int]:
    return {
        command: max(0, after.get(command, 0) - before.get(command, 0))
        for command in COMMANDS
    }


def redis_counter_failures(
    redis_mode: str,
    commands: dict[str, int],
    rejected_connections: int,
) -> list[str]:
    """Evaluate server-wide Redis counters only for the isolated test process."""
    if redis_mode != "isolated":
        return []

    failures = []
    if commands["scan"] != 0 or commands["keys"] != 0:
        failures.append("Redis commandstats observed forbidden SCAN/KEYS commands")
    if rejected_connections != 0:
        failures.append(
            f"Redis rejected {rejected_connections} connections during the load"
        )
    return failures


def percentile(values: list[float], fraction: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = max(0, math.ceil(len(ordered) * fraction) - 1)
    return ordered[index]


async def wait_for_revocation(
    services: list[TerminalSessionService],
    session_id: str,
    timeout_seconds: float,
) -> None:
    deadline = time.perf_counter() + timeout_seconds
    while time.perf_counter() < deadline:
        if all(service.is_revoked(session_id) for service in services):
            return
        await asyncio.sleep(0.001)
    raise TimeoutError(
        f"Session {session_id} was not invalidated on every Backend instance"
    )


async def delete_exact_keys(redis_url: str, session_ids: list[str]) -> None:
    client = Redis.from_url(redis_url, decode_responses=False)
    try:
        keys = [
            f"{TERMINAL_SESSION_KEY_PREFIX}{session_id}" for session_id in session_ids
        ]
        for offset in range(0, len(keys), 500):
            await client.delete(*keys[offset : offset + 500])
    finally:
        await client.aclose()


async def assert_redis_available(redis_url: str) -> None:
    client = Redis.from_url(redis_url, decode_responses=False)
    try:
        if not await client.ping():
            raise RuntimeError("Redis PING did not return success")
    finally:
        await client.aclose()


def _available_local_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        return int(listener.getsockname()[1])


async def run(
    args: argparse.Namespace,
    redis_url: str,
    *,
    redis_mode: str,
) -> dict[str, Any]:
    validate_args(args)
    await assert_redis_available(redis_url)

    run_id = uuid.uuid4().hex
    session_ids = [f"work402-load-{run_id}-{index}" for index in range(args.sessions)]
    providers = [
        RedisTerminalSessionClientProvider(redis_url) for _ in range(args.instances)
    ]
    client_factories = [provider.get_client for provider in providers]
    stores = [
        CountingRedisTerminalSessionStore(client_factory)
        for client_factory in client_factories
    ]
    services = [
        TerminalSessionService(
            store=store,
            cache_max_entries=args.cache_entries,
            invalidation_listener=RedisTerminalSessionInvalidationListener(
                client_factory,
            ),
        )
        for store, client_factory in zip(stores, client_factories)
    ]
    redis_before = await redis_snapshot(redis_url)

    try:
        await asyncio.gather(*(service.start() for service in services))
        expires_at = datetime.now(timezone.utc) + timedelta(seconds=args.ttl_seconds)

        async def register(index: int) -> None:
            service = services[index % args.instances]
            await service.register(
                TerminalSessionRecord(
                    session_id=session_ids[index],
                    user_id=7,
                    device_id=f"load-device-{index % 32}",
                    socket_id=f"executor-socket-{index % 32}",
                    project_id=123,
                    path="/workspace",
                    expires_at=expires_at,
                ),
                ttl_seconds=args.ttl_seconds,
            )

        register_started_at = time.perf_counter()
        await run_bounded(range(args.sessions), args.concurrency, register)
        register_seconds = time.perf_counter() - register_started_at

        async def attach(index: int) -> None:
            service = services[(index + 1) % args.instances]
            record = await service.authorize(
                session_ids[index],
                user_id=7,
                refresh=True,
            )
            if record is None:
                raise RuntimeError(f"Attach failed for {session_ids[index]}")

        attach_started_at = time.perf_counter()
        await run_bounded(range(args.sessions), args.concurrency, attach)
        attach_seconds = time.perf_counter() - attach_started_at

        for store in stores:
            store.gets = 0

        total_hot_events = args.sessions * args.rounds

        async def authorize_hot(event_index: int) -> None:
            session_index = event_index % args.sessions
            service = services[(session_index + 1) % args.instances]
            record = await service.authorize(
                session_ids[session_index],
                user_id=7,
            )
            if record is None:
                raise RuntimeError(
                    f"Hot-path authorization failed for {session_ids[session_index]}"
                )

        hot_started_at = time.perf_counter()
        await run_bounded(
            range(total_hot_events),
            args.concurrency,
            authorize_hot,
        )
        hot_seconds = time.perf_counter() - hot_started_at
        hot_store_gets = sum(store.gets for store in stores)

        revoked_session_ids = session_ids[: args.revocations]

        async def warm_revocation(pair: tuple[int, int]) -> None:
            session_index, instance_index = pair
            record = await services[instance_index].get(
                session_ids[session_index],
                refresh=True,
            )
            if record is None:
                raise RuntimeError(
                    f"Revocation warm-up failed for {session_ids[session_index]}"
                )

        await run_bounded(
            (
                (session_index, instance_index)
                for session_index in range(args.revocations)
                for instance_index in range(args.instances)
            ),
            args.concurrency,
            warm_revocation,
        )

        invalidation_latencies_ms: list[float] = []
        timeout_seconds = args.invalidation_timeout_ms / 1000
        for index, session_id in enumerate(revoked_session_ids):
            delete_service = services[(index + 2) % args.instances]
            started_at = time.perf_counter()
            await delete_service.delete(session_id)
            await wait_for_revocation(
                services,
                session_id,
                timeout_seconds,
            )
            invalidation_latencies_ms.append((time.perf_counter() - started_at) * 1000)

        redis_after = await redis_snapshot(redis_url)
        commands = command_delta(
            redis_before["commands"],
            redis_after["commands"],
        )
        rejected_connections = max(
            0,
            redis_after["rejected_connections"] - redis_before["rejected_connections"],
        )
        invalidation_p95_ms = percentile(invalidation_latencies_ms, 0.95)
        failures = []
        cache_covers_assigned_sessions = (
            math.ceil(args.sessions / args.instances) <= args.cache_entries
        )
        if cache_covers_assigned_sessions and hot_store_gets != 0:
            failures.append(f"steady hot path issued {hot_store_gets} Redis reads")
        failures.extend(
            redis_counter_failures(
                redis_mode,
                commands,
                rejected_connections,
            )
        )
        if invalidation_p95_ms > args.max_invalidation_p95_ms:
            failures.append(
                "cross-Backend invalidation P95 exceeded "
                f"{args.max_invalidation_p95_ms:.1f}ms"
            )

        return {
            "scenario": "backend-terminal-session-multi-instance",
            "instances": args.instances,
            "sessions": args.sessions,
            "rounds": args.rounds,
            "hot_events": total_hot_events,
            "cache_entries_per_instance": args.cache_entries,
            "register": {
                "seconds": round(register_seconds, 3),
                "operations_per_second": round(
                    args.sessions / register_seconds,
                    1,
                ),
            },
            "attach": {
                "seconds": round(attach_seconds, 3),
                "operations_per_second": round(
                    args.sessions / attach_seconds,
                    1,
                ),
            },
            "steady_hot_path": {
                "seconds": round(hot_seconds, 3),
                "events_per_second": round(total_hot_events / hot_seconds, 1),
                "redis_store_gets": hot_store_gets,
                "cache_covers_assigned_sessions": cache_covers_assigned_sessions,
            },
            "cross_instance_revocation": {
                "sessions": args.revocations,
                "p50_ms": round(percentile(invalidation_latencies_ms, 0.50), 3),
                "p95_ms": round(invalidation_p95_ms, 3),
                "p99_ms": round(percentile(invalidation_latencies_ms, 0.99), 3),
                "max_ms": round(max(invalidation_latencies_ms, default=0.0), 3),
            },
            "redis_command_calls": commands,
            "redis_connections": {
                "opened": max(
                    0,
                    redis_after["total_connections_received"]
                    - redis_before["total_connections_received"],
                ),
                "connected_at_sample": redis_after["connected_clients"],
                "server_maxclients": redis_after["maxclients"],
                "rejected": rejected_connections,
                "terminal_specific_limit": None,
            },
            "redis_key_access": "exact-known-keys-only",
            "redis_mode": redis_mode,
            "failures": failures,
            "passed": not failures,
        }
    finally:
        await asyncio.gather(
            *(service.stop() for service in services),
            return_exceptions=True,
        )
        await asyncio.gather(
            *(provider.close() for provider in providers),
            return_exceptions=True,
        )
        await delete_exact_keys(redis_url, session_ids)


async def main() -> int:
    args = parse_args()
    isolated_redis: Optional[IsolatedRedis] = None
    try:
        if args.redis_url:
            redis_url = args.redis_url
            redis_mode = "shared"
        else:
            isolated_redis = IsolatedRedis()
            redis_url = await isolated_redis.start()
            redis_mode = "isolated"
        result = await run(args, redis_url, redis_mode=redis_mode)
    except Exception as error:
        result = {
            "scenario": "backend-terminal-session-multi-instance",
            "passed": False,
            "error": str(error),
        }
    finally:
        if isolated_redis is not None:
            await isolated_redis.stop()
    print(json.dumps(result, separators=(",", ":"), sort_keys=True))
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
