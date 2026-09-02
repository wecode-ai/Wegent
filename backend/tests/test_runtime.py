# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the heterogeneous Backend process supervisor."""

from __future__ import annotations

import multiprocessing
import os
import signal
import socket
import tempfile
import time
from collections.abc import Callable
from functools import partial
from pathlib import Path
from uuid import uuid4

import pytest

from app.runtime import (
    RuntimeSupervisor,
    WorkerSpec,
    _wait_for_channel_socket,
    _wait_for_stream_socket,
    build_worker_specs,
    run_celery_worker,
    run_web_worker,
)


def _blocking_child() -> None:
    while True:
        time.sleep(0.05)


def _failing_child() -> None:
    raise SystemExit(9)


def _blocking_child_with_pid_file(pid_file: str) -> None:
    Path(pid_file).write_text(str(os.getpid()))
    _blocking_child()


def _failing_child_after_pid_file(pid_file: str) -> None:
    deadline = time.monotonic() + 2
    while not Path(pid_file).exists():
        if time.monotonic() >= deadline:
            raise SystemExit(10)
        time.sleep(0.01)
    raise SystemExit(9)


def _run_supervisor_with_pid_file(pid_file: str) -> None:
    supervisor = RuntimeSupervisor(
        [
            WorkerSpec(
                "blocking-role",
                partial(_blocking_child_with_pid_file, pid_file),
            )
        ],
        shutdown_timeout_seconds=2,
        poll_interval_seconds=0.01,
    )
    raise SystemExit(supervisor.run())


class FakeProcess:
    def __init__(self, name: str, target: Callable[[], None]) -> None:
        self.name = name
        self.target = target
        self.pid: int | None = None
        self.exitcode: int | None = None
        self.started = False
        self.terminated = False
        self.killed = False
        self.alive = False

    def start(self) -> None:
        self.started = True
        self.alive = True
        self.pid = 100

    def is_alive(self) -> bool:
        return self.alive

    def terminate(self) -> None:
        self.terminated = True
        self.alive = False

    def kill(self) -> None:
        self.killed = True
        self.alive = False

    def join(self, timeout: float | None = None) -> None:
        del timeout


class FakeContext:
    def __init__(self) -> None:
        self.processes: list[FakeProcess] = []

    def Process(
        self,
        *,
        name: str,
        target: Callable[[], None],
    ) -> FakeProcess:
        process = FakeProcess(name, target)
        self.processes.append(process)
        return process


def test_build_worker_specs_assigns_distinct_roles() -> None:
    specs = build_worker_specs()

    assert [spec.name for spec in specs] == [
        "stream-worker",
        "channel-worker",
        "backend-web",
        "maintenance-worker",
        "celery-worker",
        "celery-beat",
    ]
    assert specs[0].target is not specs[1].target


def test_non_celery_backend_uses_dedicated_scheduler_role() -> None:
    names = [spec.name for spec in build_worker_specs("apscheduler")]

    assert "scheduler-worker" in names
    # Scheduler selection must not disable ordinary Celery task consumption.
    assert "celery-worker" in names
    assert "celery-beat" not in names


def test_celery_worker_uses_pool_with_enforced_time_limits(monkeypatch) -> None:
    from app.core.celery_app import celery_app

    captured: dict[str, list[str]] = {}
    events: list[str] = []

    def record_worker_main(*, argv: list[str]) -> None:
        captured["argv"] = argv
        events.append("consume")

    monkeypatch.setattr(celery_app, "worker_main", record_worker_main)
    monkeypatch.setattr(
        "app.runtime._wait_for_stream_socket",
        lambda _socket_path: events.append("stream-ready"),
    )

    run_celery_worker()

    assert events == ["stream-ready", "consume"]
    assert "--pool=prefork" in captured["argv"]
    assert "--pool=solo" not in captured["argv"]


def test_web_startup_requires_stream_socket(tmp_path: Path) -> None:
    with pytest.raises(TimeoutError, match="did not start"):
        _wait_for_stream_socket(
            str(tmp_path / "missing.sock"),
            timeout_seconds=0.01,
        )


def test_web_startup_rejects_socket_without_ipc_readiness() -> None:
    socket_path = Path(tempfile.gettempdir()) / f"wegent-{uuid4().hex[:8]}.sock"
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(str(socket_path))
    server.listen()
    try:
        with pytest.raises(TimeoutError, match="become ready"):
            _wait_for_stream_socket(
                str(socket_path),
                timeout_seconds=0.05,
            )
    finally:
        server.close()
        socket_path.unlink(missing_ok=True)


def test_web_startup_requires_channel_worker_round_trip(tmp_path: Path) -> None:
    with pytest.raises(TimeoutError, match="did not start"):
        _wait_for_channel_socket(
            str(tmp_path / "missing-channel.sock"),
            timeout_seconds=0.01,
        )


def test_web_startup_rejects_unresponsive_channel_socket() -> None:
    socket_path = Path(tempfile.gettempdir()) / f"wegent-{uuid4().hex[:8]}.sock"
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(str(socket_path))
    server.listen()
    try:
        with pytest.raises(TimeoutError, match="become ready"):
            _wait_for_channel_socket(
                str(socket_path),
                timeout_seconds=0.05,
            )
    finally:
        server.close()
        socket_path.unlink(missing_ok=True)


def test_web_worker_binds_only_after_stream_ping(monkeypatch) -> None:
    import uvicorn

    events: list[str] = []
    uvicorn_options: dict[str, object] = {}

    monkeypatch.setattr(
        "app.runtime._wait_for_stream_socket",
        lambda _socket_path: events.append("stream-ready"),
    )
    monkeypatch.setattr(
        "app.runtime._wait_for_channel_socket",
        lambda _socket_path: events.append("channel-ready"),
    )

    def record_uvicorn_run(*args, **kwargs) -> None:
        del args
        uvicorn_options.update(kwargs)
        events.append("bind")

    monkeypatch.setattr(uvicorn, "run", record_uvicorn_run)

    run_web_worker()

    assert events == ["stream-ready", "channel-ready", "bind"]
    assert uvicorn_options["workers"] == 1
    assert uvicorn_options["limit_concurrency"] == 512


def test_supervisor_stops_all_roles_after_shutdown_request(monkeypatch) -> None:
    context = FakeContext()
    supervisor = RuntimeSupervisor(
        build_worker_specs(),
        shutdown_timeout_seconds=1,
        process_context=context,
        poll_interval_seconds=0.001,
    )
    monkeypatch.setattr(supervisor, "_install_signal_handlers", lambda: None)
    supervisor.request_shutdown(15)

    assert supervisor.run() == 0
    assert all(process.started for process in context.processes)
    assert all(process.terminated for process in context.processes)


def test_supervisor_prepares_runtime_before_starting_workers(monkeypatch) -> None:
    context = FakeContext()
    events: list[str] = []

    def prepare_runtime() -> None:
        assert context.processes == []
        events.append("prepare")

    supervisor = RuntimeSupervisor(
        build_worker_specs(),
        shutdown_timeout_seconds=1,
        before_start=prepare_runtime,
        process_context=context,
        poll_interval_seconds=0.001,
    )
    monkeypatch.setattr(supervisor, "_install_signal_handlers", lambda: None)
    supervisor.request_shutdown(15)

    assert supervisor.run() == 0
    assert events == ["prepare"]
    assert all(process.started for process in context.processes)


def test_supervisor_stops_channel_then_stream_after_consumers(
    monkeypatch,
) -> None:
    context = FakeContext()
    supervisor = RuntimeSupervisor(
        build_worker_specs(),
        shutdown_timeout_seconds=1,
        process_context=context,
        poll_interval_seconds=0.001,
    )
    monkeypatch.setattr(supervisor, "_install_signal_handlers", lambda: None)
    termination_order: list[str] = []

    original_process_factory = context.Process

    def tracked_process_factory(*, name: str, target: Callable[[], None]):
        process = original_process_factory(name=name, target=target)
        original_terminate = process.terminate

        def tracked_terminate() -> None:
            termination_order.append(process.name)
            original_terminate()

        process.terminate = tracked_terminate  # type: ignore[method-assign]
        return process

    monkeypatch.setattr(context, "Process", tracked_process_factory)
    supervisor.request_shutdown(15)

    assert supervisor.run() == 0
    assert termination_order[-2:] == ["channel-worker", "stream-worker"]


def test_supervisor_fails_container_when_role_exits(monkeypatch) -> None:
    context = FakeContext()
    supervisor = RuntimeSupervisor(
        build_worker_specs(),
        shutdown_timeout_seconds=1,
        process_context=context,
        poll_interval_seconds=0.001,
    )
    monkeypatch.setattr(supervisor, "_install_signal_handlers", lambda: None)

    def mark_first_process_failed() -> None:
        context.processes[0].alive = False
        context.processes[0].exitcode = 7

    monkeypatch.setattr(supervisor, "_start_workers", lambda: None)
    context.Process(name="backend-web", target=lambda: None).start()
    context.Process(name="stream-worker", target=lambda: None).start()
    supervisor._processes.extend(context.processes)
    mark_first_process_failed()

    assert supervisor.run() == 7
    assert context.processes[1].terminated is True


def test_supervisor_uses_real_spawned_processes(monkeypatch) -> None:
    supervisor = RuntimeSupervisor(
        [
            WorkerSpec("blocking-role", _blocking_child),
            WorkerSpec("failing-role", _failing_child),
        ],
        shutdown_timeout_seconds=2,
        poll_interval_seconds=0.01,
    )
    monkeypatch.setattr(supervisor, "_install_signal_handlers", lambda: None)

    assert supervisor.run() == 9


def test_supervisor_reaps_sibling_when_one_real_child_exits(
    monkeypatch, tmp_path: Path
) -> None:
    pid_file = tmp_path / "blocking.pid"
    supervisor = RuntimeSupervisor(
        [
            WorkerSpec(
                "blocking-role",
                partial(_blocking_child_with_pid_file, str(pid_file)),
            ),
            WorkerSpec(
                "failing-role",
                partial(_failing_child_after_pid_file, str(pid_file)),
            ),
        ],
        shutdown_timeout_seconds=2,
        poll_interval_seconds=0.01,
    )
    monkeypatch.setattr(supervisor, "_install_signal_handlers", lambda: None)

    assert supervisor.run() == 9
    blocking_pid = int(pid_file.read_text())
    with pytest.raises(ProcessLookupError):
        os.kill(blocking_pid, 0)


def test_supervisor_sigterm_reaps_real_child(tmp_path: Path) -> None:
    pid_file = tmp_path / "blocking.pid"
    context = multiprocessing.get_context("spawn")
    supervisor_process = context.Process(
        target=_run_supervisor_with_pid_file,
        args=(str(pid_file),),
    )
    supervisor_process.start()
    try:
        deadline = time.monotonic() + 5
        while not pid_file.exists():
            if not supervisor_process.is_alive():
                pytest.fail("Runtime supervisor exited before its child became ready")
            if time.monotonic() >= deadline:
                pytest.fail("Runtime supervisor child did not become ready")
            time.sleep(0.01)

        child_pid = int(pid_file.read_text())
        os.kill(supervisor_process.pid, signal.SIGTERM)
        supervisor_process.join(timeout=5)

        assert supervisor_process.exitcode == 0
        with pytest.raises(ProcessLookupError):
            os.kill(child_pid, 0)
    finally:
        if supervisor_process.is_alive():
            supervisor_process.kill()
            supervisor_process.join()
