# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import atexit
import logging
import logging.config
import math
import os
import queue
import sys
import threading
import time
from logging.handlers import TimedRotatingFileHandler

from app.core.config import settings
from shared.utils.sensitive_data_masker import mask_string

_DEFAULT_QUEUE_CAPACITY = 2048
_DEFAULT_DROP_REPORT_INTERVAL_SECONDS = 30.0
_DEFAULT_SHUTDOWN_TIMEOUT_SECONDS = 0.25
_DEFAULT_FILE_BACKUP_COUNT = 24
_LISTENER_POLL_INTERVAL_SECONDS = 0.05
_MAX_DROPPED_RECORDS = (1 << 63) - 1


class _ListenerOwnedHandlerMixin:
    """Keep sink I/O exclusively on its listener thread."""

    _listener_owner: tuple[int, int] | None = None

    def bind_listener_thread(self) -> None:
        self._listener_owner = (os.getpid(), threading.get_ident())

    def _is_listener_thread(self) -> bool:
        owner = self._listener_owner
        return owner is None or owner == (os.getpid(), threading.get_ident())

    def acquire(self) -> None:
        if self._is_listener_thread():
            super().acquire()

    def release(self) -> None:
        if self._is_listener_thread():
            super().release()

    def flush(self) -> None:
        if self._is_listener_thread():
            super().flush()

    def close(self) -> None:
        if self._is_listener_thread():
            super().close()

    def handleError(self, record: logging.LogRecord) -> None:
        """Keep sink failures out of stderr and the logging graph."""
        return None


class ListenerOwnedStreamHandler(_ListenerOwnedHandlerMixin, logging.StreamHandler):
    """A stream handler that cannot perform I/O outside its listener thread."""


class HourlyRotatingFileHandler(_ListenerOwnedHandlerMixin, TimedRotatingFileHandler):
    """
    TimedRotatingFileHandler with clock-snapped, multi-process-safe rotation.

    All formatting, writes, flushes, and rollovers are additionally restricted to
    the per-process logging listener thread.
    """

    def computeRollover(self, currentTime: float) -> float:
        """Snap to the start of the next local clock hour."""
        if self.utc:
            offset = 0
        else:
            offset = -time.timezone
            if time.daylight and time.localtime(currentTime).tm_isdst:
                offset = -time.altzone
        local_time = currentTime + offset
        next_hour = (math.floor(local_time / 3600) + 1) * 3600
        return next_hour - offset

    def getFilesToDelete(self) -> list[str]:
        """Return expired archives matching Wegent's compact hourly suffix."""
        directory, filename = os.path.split(self.baseFilename)
        prefix = f"{filename}."
        archives: list[str] = []
        for entry in os.listdir(directory or "."):
            if not entry.startswith(prefix):
                continue
            suffix = entry[len(prefix) :]
            try:
                time.strptime(suffix, "%Y%m%d-%H")
            except ValueError:
                continue
            archives.append(os.path.join(directory, entry))
        archives.sort()
        if len(archives) <= self.backupCount:
            return []
        return archives[: len(archives) - self.backupCount]

    def doRollover(self) -> None:
        """Rotate with an exclusive file lock to handle concurrent processes."""
        import fcntl

        lock_path = self.baseFilename + ".lock"
        with open(lock_path, "a") as lock_file:
            fcntl.flock(lock_file, fcntl.LOCK_EX)
            try:
                self._do_rollover_locked()
            finally:
                fcntl.flock(lock_file, fcntl.LOCK_UN)

    def _do_rollover_locked(self) -> None:
        """Run the rollover while holding the cross-process lock."""
        if self.stream:
            self.stream.close()
            self.stream = None

        rollover_time = self.rolloverAt - self.interval
        time_tuple = (
            time.gmtime(rollover_time) if self.utc else time.localtime(rollover_time)
        )
        destination = self.rotation_filename(
            self.baseFilename + "." + time.strftime(self.suffix, time_tuple)
        )
        if not os.path.exists(destination):
            self.rotate(self.baseFilename, destination)

        if self.backupCount > 0:
            for expired_path in self.getFilesToDelete():
                try:
                    os.remove(expired_path)
                except FileNotFoundError:
                    continue

        self.stream = self._open()
        now = int(time.time())
        new_rollover = self.computeRollover(now)
        while new_rollover <= now:
            new_rollover += self.interval
        self.rolloverAt = new_rollover


def _set_request_id(record: logging.LogRecord) -> None:
    if hasattr(record, "request_id"):
        return
    try:
        from shared.telemetry.context.span import get_request_id

        request_id = get_request_id()
        record.request_id = request_id if request_id else "-"
    except Exception:
        record.request_id = "-"


class RequestIdFilter(logging.Filter):
    """Snapshot the current request ID onto a log record."""

    def filter(self, record: logging.LogRecord) -> bool:
        _set_request_id(record)
        return True


class SensitiveDataFormatter(logging.Formatter):
    """Mask credentials after rendering the complete log record."""

    def format(self, record: logging.LogRecord) -> str:
        return mask_string(super().format(record))


class _DropCounter:
    """A saturating counter whose producer path never waits for a lock."""

    def __init__(self) -> None:
        self._count = 0
        self._contended = False
        self._lock = threading.Lock()

    def increment(self) -> None:
        if not self._lock.acquire(blocking=False):
            self._contended = True
            return
        try:
            contended_drop = 1 if self._contended else 0
            self._contended = False
            self._count = min(
                _MAX_DROPPED_RECORDS,
                self._count + 1 + contended_drop,
            )
        finally:
            self._lock.release()

    def take(self) -> int:
        with self._lock:
            count = self._count + (1 if self._contended else 0)
            self._count = 0
            self._contended = False
        return min(_MAX_DROPPED_RECORDS, count)


class NonBlockingQueueHandler(logging.Handler):
    """Enqueue raw records without formatting, waiting, or fallback I/O."""

    def __init__(
        self,
        records: queue.Queue[logging.LogRecord],
        dropped: _DropCounter,
    ) -> None:
        super().__init__()
        self._records = records
        self._dropped = dropped
        self._accepting = True

    def handle(self, record: logging.LogRecord) -> bool:
        if not self._accepting or not self.filter(record):
            return False
        self.emit(record)
        return True

    def emit(self, record: logging.LogRecord) -> None:
        _set_request_id(record)
        try:
            self._records.put_nowait(record)
        except queue.Full:
            self._dropped.increment()

    def stop_accepting(self) -> None:
        self._accepting = False

    def close(self) -> None:
        self.stop_accepting()
        super().close()


class _AsyncLoggingRuntime:
    """Own one bounded log queue and one sink thread for a single process."""

    def __init__(
        self,
        targets: list[logging.Handler],
        *,
        queue_capacity: int = _DEFAULT_QUEUE_CAPACITY,
        drop_report_interval: float = _DEFAULT_DROP_REPORT_INTERVAL_SECONDS,
    ) -> None:
        if queue_capacity <= 0:
            raise ValueError("queue_capacity must be positive")
        self.pid = os.getpid()
        self._targets = targets
        self._records: queue.Queue[logging.LogRecord] = queue.Queue(queue_capacity)
        self._dropped = _DropCounter()
        self.handler = NonBlockingQueueHandler(self._records, self._dropped)
        self._drop_report_interval = max(0.0, drop_report_interval)
        self._next_drop_report = 0.0
        self._stop = threading.Event()
        self._ready = threading.Event()
        self._drain_deadline = float("inf")
        self._thread = threading.Thread(
            target=self._run,
            name=f"wegent-log-listener-{self.pid}",
            daemon=True,
        )

    @property
    def listener_thread(self) -> threading.Thread:
        return self._thread

    @property
    def targets(self) -> tuple[logging.Handler, ...]:
        return tuple(self._targets)

    def start(self) -> None:
        self._thread.start()
        self._ready.wait(timeout=1.0)

    def shutdown(self, timeout: float) -> bool:
        self.handler.stop_accepting()
        timeout = max(0.0, timeout)
        self._drain_deadline = time.monotonic() + timeout
        self._stop.set()
        if self._thread.is_alive():
            self._thread.join(timeout=timeout)
        return not self._thread.is_alive()

    def detach_after_fork(self) -> None:
        """Disable the inherited producer without touching inherited locks."""
        self.handler.stop_accepting()
        root_logger = logging.getLogger()
        if self.handler in root_logger.handlers:
            root_logger.removeHandler(self.handler)

    def _run(self) -> None:
        for target in self._targets:
            if isinstance(target, _ListenerOwnedHandlerMixin):
                target.bind_listener_thread()
        self._ready.set()
        try:
            self._consume_records()
        finally:
            self._report_dropped(force=True)
            self._close_targets()

    def _consume_records(self) -> None:
        while not self._should_exit():
            try:
                record = self._records.get(
                    timeout=_LISTENER_POLL_INTERVAL_SECONDS,
                )
            except queue.Empty:
                self._report_dropped()
                continue
            self._dispatch(record)
            self._report_dropped()

    def _should_exit(self) -> bool:
        if not self._stop.is_set():
            return False
        return self._records.empty() or time.monotonic() >= self._drain_deadline

    def _dispatch(self, record: logging.LogRecord) -> None:
        for target in self._targets:
            if record.levelno < target.level:
                continue
            try:
                target.handle(record)
            except Exception:
                # A sink failure must not terminate the listener or recurse to logs.
                continue

    def _report_dropped(self, *, force: bool = False) -> None:
        now = time.monotonic()
        if not force and now < self._next_drop_report:
            return
        count = self._dropped.take()
        if count == 0:
            return
        self._next_drop_report = now + self._drop_report_interval
        record = logging.LogRecord(
            name="app.core.logging",
            level=logging.WARNING,
            pathname=__file__,
            lineno=0,
            msg="Dropped %d log records because the async log queue was full",
            args=(count,),
            exc_info=None,
        )
        record.request_id = "-"
        self._dispatch(record)

    def _close_targets(self) -> None:
        for target in self._targets:
            try:
                target.flush()
                target.close()
            except Exception:
                continue


_runtime_lock = threading.RLock()
_runtime: _AsyncLoggingRuntime | None = None


def _create_file_handler(log_format: str, datefmt: str) -> logging.Handler | None:
    """Create the optional listener-owned hourly rotating file sink."""
    if not settings.LOG_FILE_ENABLED:
        return None

    log_dir = settings.LOG_DIR
    try:
        os.makedirs(log_dir, exist_ok=True)
    except OSError as exc:
        print(
            f"[logging] WARNING: cannot create log directory {log_dir!r}: {exc}; "
            "falling back to console-only logging.",
            file=sys.stderr,
        )
        return None

    file_handler = HourlyRotatingFileHandler(
        filename=os.path.join(log_dir, "info.log"),
        when="h",
        interval=1,
        backupCount=_DEFAULT_FILE_BACKUP_COUNT,
        encoding="utf-8",
        utc=False,
    )
    file_handler.suffix = "%Y%m%d-%H"
    file_handler.setFormatter(SensitiveDataFormatter(log_format, datefmt=datefmt))
    file_handler.setLevel(logging.DEBUG)
    file_handler.addFilter(RequestIdFilter())
    return file_handler


def _create_targets(log_format: str, datefmt: str) -> list[logging.Handler]:
    # Celery may replace sys.stdout with a LoggingProxy. Writing a log handler
    # to that proxy feeds each formatted record back into logging recursively.
    # The interpreter-owned stream always points at the actual process stdout.
    console_stream = sys.__stdout__ if sys.__stdout__ is not None else sys.stdout
    console_handler = ListenerOwnedStreamHandler(console_stream)
    console_handler.setFormatter(SensitiveDataFormatter(log_format, datefmt=datefmt))
    console_handler.setLevel(logging.DEBUG)
    console_handler.addFilter(RequestIdFilter())
    targets: list[logging.Handler] = [console_handler]
    file_handler = _create_file_handler(log_format, datefmt)
    if file_handler is not None:
        targets.append(file_handler)
    return targets


def _configure_logger_hierarchy(log_level: int) -> None:
    logging.getLogger("app").setLevel(log_level)
    for name in ["uvicorn", "uvicorn.error", "fastapi"]:
        logger = logging.getLogger(name)
        logger.handlers.clear()
        logger.propagate = True
    for name in ("httpx", "httpcore"):
        logging.getLogger(name).setLevel(logging.WARNING)
    access_logger = logging.getLogger("uvicorn.access")
    access_logger.handlers.clear()
    access_logger.propagate = False


def setup_logging() -> None:
    """Install one nonblocking producer and one sink listener per process."""
    global _runtime

    log_level_name = os.environ.get("LOG_LEVEL", "INFO").upper()
    log_level = getattr(logging, log_level_name, logging.INFO)
    log_format = (
        "%(asctime)s %(levelname)-4s [%(request_id)s] "
        "%(pathname)s:%(lineno)d : %(message)s"
    )
    datefmt = "%Y-%m-%d %H:%M:%S"
    root_logger = logging.getLogger()

    with _runtime_lock:
        if (
            _runtime is not None
            and _runtime.pid == os.getpid()
            and _runtime.handler in root_logger.handlers
            and _runtime.listener_thread.is_alive()
        ):
            root_logger.setLevel(log_level)
            _configure_logger_hierarchy(log_level)
            return

        previous_runtime = _runtime
        _runtime = None
        if previous_runtime is not None:
            previous_runtime.shutdown(_DEFAULT_SHUTDOWN_TIMEOUT_SECONDS)

        runtime = _AsyncLoggingRuntime(_create_targets(log_format, datefmt))
        runtime.start()
        root_logger.setLevel(log_level)
        root_logger.handlers.clear()
        root_logger.addHandler(runtime.handler)
        _runtime = runtime
        _configure_logger_hierarchy(log_level)

    root_logger.info(
        "Logging configured with level: %s (%s)",
        log_level_name,
        log_level,
    )
    for target in runtime.targets:
        if isinstance(target, HourlyRotatingFileHandler):
            root_logger.info("File logging enabled: %s", target.baseFilename)


def shutdown_logging(
    timeout: float = _DEFAULT_SHUTDOWN_TIMEOUT_SECONDS,
) -> bool:
    """Stop accepting logs and drain for at most *timeout* seconds."""
    global _runtime

    with _runtime_lock:
        runtime = _runtime
        _runtime = None
        if runtime is None:
            return True
        root_logger = logging.getLogger()
        if runtime.handler in root_logger.handlers:
            root_logger.removeHandler(runtime.handler)
    return runtime.shutdown(timeout)


def _after_fork_child() -> None:
    global _runtime, _runtime_lock

    inherited_runtime = _runtime
    _runtime = None
    _runtime_lock = threading.RLock()
    if inherited_runtime is not None:
        inherited_runtime.detach_after_fork()


if hasattr(os, "register_at_fork"):
    os.register_at_fork(after_in_child=_after_fork_child)
atexit.register(shutdown_logging)
