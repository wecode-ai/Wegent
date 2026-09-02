# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Single-container supervisor for heterogeneous Backend worker processes."""

from __future__ import annotations

import asyncio
import logging
import multiprocessing
import os
import signal
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from types import FrameType
from typing import Protocol, cast

logger = logging.getLogger(__name__)


class ProcessHandle(Protocol):
    """Process operations required by the runtime supervisor."""

    name: str
    pid: int | None
    exitcode: int | None

    def start(self) -> None:
        """Start the process."""
        ...

    def is_alive(self) -> bool:
        """Return whether the process is alive."""
        ...

    def terminate(self) -> None:
        """Request graceful process termination."""
        ...

    def kill(self) -> None:
        """Force process termination."""
        ...

    def join(self, timeout: float | None = None) -> None:
        """Wait for process termination."""
        ...


class ProcessContext(Protocol):
    """Multiprocessing context used to construct isolated child processes."""

    def Process(
        self,
        *,
        name: str,
        target: Callable[[], None],
    ) -> ProcessHandle:
        """Construct a process without starting it."""
        ...


@dataclass(frozen=True)
class WorkerSpec:
    """One named process role managed by the Backend runtime."""

    name: str
    target: Callable[[], None]


def run_web_worker() -> None:
    """Run the only network-facing Uvicorn process."""
    import uvicorn

    from app.core.config import settings

    _wait_for_stream_socket(settings.STREAM_WORKER_SOCKET_PATH)
    _wait_for_channel_socket(settings.CHANNEL_WORKER_SOCKET_PATH)
    uvicorn.run(
        "app.main:app",
        host=os.getenv("HOST", "0.0.0.0"),
        port=_positive_int_environment("PORT", 8000),
        workers=1,
        limit_concurrency=_positive_int_environment(
            "WEB_MAX_CONCURRENCY",
            settings.WEB_MAX_CONCURRENCY,
        ),
        timeout_graceful_shutdown=_positive_int_environment(
            "GRACEFUL_SHUTDOWN_TIMEOUT",
            600,
        ),
    )


def run_stream_worker() -> None:
    """Run one isolated stream-command consumer process."""
    from app.stream_worker import main

    main()


def run_channel_worker() -> None:
    """Run the process that exclusively owns persistent IM providers."""
    from app.channel_worker import main

    main()


def run_maintenance_worker() -> None:
    """Run repository and stale-resource maintenance loops."""
    from app.maintenance_worker import main

    main()


def run_celery_worker() -> None:
    """Run Celery task consumption in a supervisor-owned process."""
    from app.core.celery_app import celery_app
    from app.core.config import settings

    _wait_for_stream_socket(settings.STREAM_WORKER_SOCKET_PATH)
    celery_app.worker_main(
        argv=[
            "worker",
            "--loglevel=info",
            "--pool=prefork",
            "--concurrency=1",
            "--without-heartbeat",
            "--without-gossip",
            "--without-mingle",
        ]
    )


def run_celery_beat() -> None:
    """Run the periodic Celery scheduler in its own process."""
    from celery.apps.beat import Beat

    from app.core.celery_app import celery_app

    Beat(app=celery_app, loglevel="INFO").run()


def run_scheduler_worker() -> None:
    """Run a configured non-Celery scheduler backend."""
    from app.scheduler_worker import main

    main()


def build_worker_specs(
    scheduler_backend: str = "celery",
) -> list[WorkerSpec]:
    """Build the heterogeneous roles for one Backend container."""
    specs = [
        WorkerSpec("stream-worker", run_stream_worker),
        WorkerSpec("channel-worker", run_channel_worker),
        WorkerSpec("backend-web", run_web_worker),
        WorkerSpec("maintenance-worker", run_maintenance_worker),
        WorkerSpec("celery-worker", run_celery_worker),
    ]
    if scheduler_backend == "celery":
        specs.append(WorkerSpec("celery-beat", run_celery_beat))
    else:
        specs.append(WorkerSpec("scheduler-worker", run_scheduler_worker))
    return specs


class RuntimeSupervisor:
    """Keep heterogeneous child roles alive and shut them down as one unit."""

    def __init__(
        self,
        specs: Sequence[WorkerSpec],
        *,
        shutdown_timeout_seconds: float,
        before_start: Callable[[], None] | None = None,
        process_context: ProcessContext | None = None,
        poll_interval_seconds: float = 0.5,
    ) -> None:
        if not specs:
            raise ValueError("At least one worker process is required")
        if shutdown_timeout_seconds <= 0:
            raise ValueError("shutdown_timeout_seconds must be positive")
        if poll_interval_seconds <= 0:
            raise ValueError("poll_interval_seconds must be positive")
        self._specs = list(specs)
        self._shutdown_timeout_seconds = shutdown_timeout_seconds
        self._before_start = before_start
        self._context = process_context or cast(
            ProcessContext,
            multiprocessing.get_context("spawn"),
        )
        self._poll_interval_seconds = poll_interval_seconds
        self._processes: list[ProcessHandle] = []
        self._shutdown_requested = False

    def run(self) -> int:
        """Start all roles and return nonzero when any role exits unexpectedly."""
        self._install_signal_handlers()
        exit_code = 1
        try:
            if self._before_start is not None:
                self._before_start()
            self._start_workers()
            exit_code = self._wait_for_exit()
        except Exception:
            logger.exception("Backend runtime supervisor failed")
        finally:
            self._stop_workers()
        return exit_code

    def request_shutdown(
        self,
        signum: int,
        frame: FrameType | None = None,
    ) -> None:
        """Record a container shutdown request for the supervision loop."""
        del frame
        logger.info("Backend runtime received signal %s", signum)
        self._shutdown_requested = True

    def _install_signal_handlers(self) -> None:
        for handled_signal in (signal.SIGINT, signal.SIGTERM):
            signal.signal(handled_signal, self.request_shutdown)

    def _start_workers(self) -> None:
        for spec in self._specs:
            process = self._context.Process(name=spec.name, target=spec.target)
            process.start()
            self._processes.append(process)
            logger.info(
                "Backend runtime started role=%s pid=%s",
                process.name,
                process.pid,
            )

    def _wait_for_exit(self) -> int:
        while not self._shutdown_requested:
            for process in self._processes:
                if process.exitcode is not None:
                    logger.error(
                        "Backend runtime role exited: role=%s pid=%s exit_code=%s",
                        process.name,
                        process.pid,
                        process.exitcode,
                    )
                    return process.exitcode or 1
            time.sleep(self._poll_interval_seconds)
        return 0

    def _stop_workers(self) -> None:
        alive = [process for process in self._processes if process.is_alive()]
        deadline = time.monotonic() + self._shutdown_timeout_seconds

        # Keep Pod-local providers alive while consumers drain. Channel ingress
        # can dispatch stream work, so it stops after Web/Celery but before the
        # stream provider.
        stream_processes = [
            process for process in alive if process.name == "stream-worker"
        ]
        channel_processes = [
            process for process in alive if process.name == "channel-worker"
        ]
        stream_consumers = [
            process
            for process in alive
            if process.name not in {"channel-worker", "stream-worker"}
        ]
        self._terminate_and_join(stream_consumers, deadline)
        self._terminate_and_join(channel_processes, deadline)
        self._terminate_and_join(stream_processes, deadline)

        force_killed = [process for process in alive if process.is_alive()]
        for process in force_killed:
            logger.error(
                "Backend runtime force-killing role=%s pid=%s",
                process.name,
                process.pid,
            )
            process.kill()
        for process in force_killed:
            process.join()

    @staticmethod
    def _terminate_and_join(
        processes: Sequence[ProcessHandle],
        deadline: float,
    ) -> None:
        """Stop one dependency layer and wait within the shared deadline."""
        for process in processes:
            process.terminate()
        for process in processes:
            process.join(timeout=max(deadline - time.monotonic(), 0))


def _positive_int_environment(name: str, default: int) -> int:
    value = int(os.getenv(name, str(default)))
    if value <= 0:
        raise ValueError(f"{name} must be positive")
    return value


def _wait_for_stream_socket(
    socket_path: str,
    *,
    timeout_seconds: float = 30,
) -> None:
    """Delay Web readiness until the sibling handles a real IPC round trip."""
    from app.services.execution.stream_client import (
        StreamExecutionClient,
        StreamWorkerExecutionError,
        StreamWorkerUnavailableError,
    )

    deadline = time.monotonic() + timeout_seconds
    last_error: Exception | None = None
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError(
                f"Local stream worker did not start or become ready: {socket_path}"
            ) from last_error

        probe_timeout = min(remaining, 0.5)
        client = StreamExecutionClient(
            socket_path,
            connect_timeout_seconds=probe_timeout,
            first_frame_timeout_seconds=probe_timeout,
        )
        try:
            asyncio.run(client.ping())
            return
        except (StreamWorkerExecutionError, StreamWorkerUnavailableError) as error:
            last_error = error

        time.sleep(min(0.05, max(deadline - time.monotonic(), 0)))


def _wait_for_channel_socket(
    socket_path: str,
    *,
    timeout_seconds: float = 30,
) -> None:
    """Delay Web readiness until channel-worker completes a real IPC ping."""
    from app.services.channels.worker_client import (
        ChannelWorkerClient,
        ChannelWorkerError,
        ChannelWorkerUnavailableError,
    )

    deadline = time.monotonic() + timeout_seconds
    last_error: Exception | None = None
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError(
                f"Local channel worker did not start or become ready: {socket_path}"
            ) from last_error

        probe_timeout = min(remaining, 0.5)
        client = ChannelWorkerClient(
            socket_path,
            connect_timeout_seconds=probe_timeout,
            response_timeout_seconds=probe_timeout,
            frame_write_timeout_seconds=probe_timeout,
        )
        try:
            asyncio.run(client.ping())
            return
        except (ChannelWorkerError, ChannelWorkerUnavailableError) as error:
            last_error = error

        time.sleep(min(0.05, max(deadline - time.monotonic(), 0)))


def main() -> None:
    """Run the single-container heterogeneous process pool."""
    from app.core.config import settings
    from app.core.database_migrations import prepare_runtime_database_schema
    from app.core.logging import setup_logging

    setup_logging()
    supervisor = RuntimeSupervisor(
        build_worker_specs(
            settings.SCHEDULER_BACKEND,
        ),
        shutdown_timeout_seconds=settings.GRACEFUL_SHUTDOWN_TIMEOUT,
        before_start=prepare_runtime_database_schema,
    )
    raise SystemExit(supervisor.run())


if __name__ == "__main__":
    main()
