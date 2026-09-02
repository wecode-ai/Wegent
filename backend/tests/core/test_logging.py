# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import io
import logging
import sys
import threading
import time
from pathlib import Path

import app.core.logging as logging_module
from app.core.logging import (
    HourlyRotatingFileHandler,
    ListenerOwnedStreamHandler,
    SensitiveDataFormatter,
    _AsyncLoggingRuntime,
)


def _record(message: str) -> logging.LogRecord:
    return logging.LogRecord(
        name="test",
        level=logging.INFO,
        pathname=__file__,
        lineno=1,
        msg=message,
        args=(),
        exc_info=None,
    )


def _wait_until(predicate, timeout: float = 1.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.005)
    return predicate()


class _BlockingStream:
    def __init__(self) -> None:
        self.write_started = threading.Event()
        self.release_write = threading.Event()
        self.chunks: list[str] = []
        self.write_thread_ids: list[int] = []
        self._block_next_write = True

    def write(self, value: str) -> int:
        self.write_thread_ids.append(threading.get_ident())
        if self._block_next_write:
            self._block_next_write = False
            self.write_started.set()
            self.release_write.wait(timeout=5.0)
        self.chunks.append(value)
        return len(value)

    def flush(self) -> None:
        return None

    def text(self) -> str:
        return "".join(self.chunks)


def test_sensitive_data_formatter_masks_jwt_tokens() -> None:
    formatter = SensitiveDataFormatter("%(message)s")
    record = logging.LogRecord(
        name="test",
        level=logging.INFO,
        pathname=__file__,
        lineno=1,
        msg="auth_token=eyJheader.eyJpayload.signature",
        args=(),
        exc_info=None,
    )

    output = formatter.format(record)

    assert "eyJheader.eyJpayload.signature" not in output


def test_console_target_uses_interpreter_stdout_when_stdout_is_logging_proxy(
    monkeypatch,
) -> None:
    interpreter_stdout = io.StringIO()
    redirected_stdout = io.StringIO()
    monkeypatch.setattr(sys, "__stdout__", interpreter_stdout)
    monkeypatch.setattr(sys, "stdout", redirected_stdout)

    targets = logging_module._create_targets("%(message)s", "%Y-%m-%d")

    assert isinstance(targets[0], ListenerOwnedStreamHandler)
    assert targets[0].stream is interpreter_stdout
    for target in targets:
        target.close()


def test_http_client_access_logs_are_suppressed_below_warning() -> None:
    logging_module._configure_logger_hierarchy(logging.INFO)

    assert logging.getLogger("httpx").level == logging.WARNING
    assert logging.getLogger("httpcore").level == logging.WARNING


def test_formatter_runs_only_on_listener_thread(monkeypatch) -> None:
    formatted = threading.Event()
    formatter_thread_ids: list[int] = []

    def track_masking(value: str) -> str:
        formatter_thread_ids.append(threading.get_ident())
        formatted.set()
        return value

    monkeypatch.setattr(logging_module, "mask_string", track_masking)
    stream = io.StringIO()
    target = ListenerOwnedStreamHandler(stream)
    target.setFormatter(SensitiveDataFormatter("%(message)s"))
    runtime = _AsyncLoggingRuntime([target])
    runtime.start()

    caller_thread_id = threading.get_ident()
    runtime.handler.handle(_record("format-me"))

    assert formatted.wait(timeout=1.0)
    assert formatter_thread_ids == [runtime.listener_thread.ident]
    assert formatter_thread_ids[0] != caller_thread_id
    assert runtime.shutdown(1.0)


def test_full_queue_never_blocks_and_listener_reports_drops() -> None:
    stream = _BlockingStream()
    target = ListenerOwnedStreamHandler(stream)
    target.setFormatter(logging.Formatter("%(message)s"))
    runtime = _AsyncLoggingRuntime(
        [target],
        queue_capacity=1,
        drop_report_interval=60.0,
    )
    runtime.start()
    runtime.handler.handle(_record("first"))
    assert stream.write_started.wait(timeout=1.0)

    runtime.handler.handle(_record("second"))
    started = time.monotonic()
    runtime.handler.handle(_record("dropped-one"))
    runtime.handler.handle(_record("dropped-two"))
    enqueue_duration = time.monotonic() - started

    assert enqueue_duration < 0.05
    stream.release_write.set()
    assert _wait_until(lambda: "Dropped 2 log records" in stream.text())
    assert stream.text().count("async log queue was full") == 1
    assert runtime.shutdown(1.0)


def test_slow_stdout_does_not_block_producer_or_shutdown() -> None:
    stream = _BlockingStream()
    target = ListenerOwnedStreamHandler(stream)
    target.setFormatter(logging.Formatter("%(message)s"))
    runtime = _AsyncLoggingRuntime([target], queue_capacity=2)
    runtime.start()

    started = time.monotonic()
    runtime.handler.handle(_record("slow-output"))
    enqueue_duration = time.monotonic() - started
    assert enqueue_duration < 0.05
    assert stream.write_started.wait(timeout=1.0)

    started = time.monotonic()
    stopped = runtime.shutdown(0.02)
    shutdown_duration = time.monotonic() - started
    assert not stopped
    assert shutdown_duration < 0.15

    stream.release_write.set()
    assert runtime.shutdown(1.0)


def test_shutdown_drains_queued_records() -> None:
    stream = io.StringIO()
    target = ListenerOwnedStreamHandler(stream)
    target.setFormatter(logging.Formatter("%(message)s"))
    runtime = _AsyncLoggingRuntime([target], queue_capacity=16)
    runtime.start()
    for index in range(10):
        runtime.handler.handle(_record(f"record-{index}"))

    assert runtime.shutdown(1.0)
    for index in range(10):
        assert f"record-{index}" in stream.getvalue()


def test_file_rollover_runs_on_listener_thread(tmp_path: Path, monkeypatch) -> None:
    log_path = tmp_path / "info.log"
    target = HourlyRotatingFileHandler(
        filename=log_path,
        when="h",
        interval=1,
        backupCount=0,
        encoding="utf-8",
    )
    target.setFormatter(logging.Formatter("%(message)s"))
    rollover_thread_ids: list[int] = []
    rollover_finished = threading.Event()
    original_rollover = target._do_rollover_locked

    def track_rollover() -> None:
        rollover_thread_ids.append(threading.get_ident())
        original_rollover()
        rollover_finished.set()

    monkeypatch.setattr(target, "_do_rollover_locked", track_rollover)
    target.rolloverAt = 0
    runtime = _AsyncLoggingRuntime([target])
    runtime.start()
    runtime.handler.handle(_record("after-rollover"))

    assert rollover_finished.wait(timeout=1.0)
    assert runtime.shutdown(1.0)
    assert rollover_thread_ids == [runtime.listener_thread.ident]
    assert "after-rollover" in log_path.read_text(encoding="utf-8")
    archives = [
        path for path in tmp_path.glob("info.log.*") if not path.name.endswith(".lock")
    ]
    assert len(archives) == 1


def test_hourly_rollover_deletes_archives_beyond_backup_count(tmp_path: Path) -> None:
    log_path = tmp_path / "info.log"
    log_path.write_text("current", encoding="utf-8")
    target = HourlyRotatingFileHandler(
        filename=log_path,
        when="h",
        interval=1,
        backupCount=2,
        encoding="utf-8",
    )
    target.suffix = "%Y%m%d-%H"
    for suffix in ("20260831-10", "20260831-11", "20260831-12"):
        (tmp_path / f"info.log.{suffix}").write_text(suffix, encoding="utf-8")

    target.rolloverAt = int(time.time())
    target._do_rollover_locked()
    target.close()

    archives = sorted(
        path.name
        for path in tmp_path.glob("info.log.*")
        if not path.name.endswith(".lock")
    )
    assert len(archives) == 2


def test_after_fork_detaches_inherited_runtime() -> None:
    previous_runtime = logging_module._runtime
    previous_lock = logging_module._runtime_lock
    root_logger = logging.getLogger()
    previous_handlers = list(root_logger.handlers)
    runtime = _AsyncLoggingRuntime([ListenerOwnedStreamHandler(io.StringIO())])
    runtime.start()
    root_logger.addHandler(runtime.handler)
    logging_module._runtime = runtime

    try:
        logging_module._after_fork_child()

        assert logging_module._runtime is None
        assert runtime.handler not in root_logger.handlers
        assert not runtime.handler.handle(_record("must-not-enqueue"))
    finally:
        runtime.shutdown(1.0)
        root_logger.handlers[:] = previous_handlers
        logging_module._runtime = previous_runtime
        logging_module._runtime_lock = previous_lock
