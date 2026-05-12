# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import logging
import logging.config
import math
import os
import sys
import time
from logging.handlers import TimedRotatingFileHandler

from app.core.config import settings


class HourlyRotatingFileHandler(TimedRotatingFileHandler):
    """
    TimedRotatingFileHandler with two improvements over the stdlib default:

    1. Clock-snapped rotation: rolls over exactly on the hour boundary (HH:00:00)
       instead of startTime + 3600, so log files reliably map to a single clock-hour
       regardless of when the process started.

    2. Multi-process safety: acquires an exclusive flock before rotating so that
       concurrent uvicorn/Celery workers sharing the same log file do not corrupt
       each other's output or produce duplicate rotated files.
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
        """Inner rotation logic, called while holding the exclusive lock."""
        if self.stream:
            self.stream.close()
            self.stream = None

        # Compute destination filename (mirrors stdlib logic)
        t = self.rolloverAt - self.interval
        timeTuple = time.localtime(t) if not self.utc else time.gmtime(t)
        dfn = self.rotation_filename(
            self.baseFilename + "." + time.strftime(self.suffix, timeTuple)
        )

        if not os.path.exists(dfn):
            # This process wins the race: perform the actual rename.
            self.rotate(self.baseFilename, dfn)
        # else: another process already rotated; just reopen below.

        # Reopen stream on the (possibly new) base file and advance rolloverAt.
        self.stream = self._open()
        now = int(time.time())
        new_rollover = self.computeRollover(now)
        # Guard against clock skew right on the boundary
        while new_rollover <= now:
            new_rollover += self.interval
        self.rolloverAt = new_rollover


class RequestIdFilter(logging.Filter):
    """
    A logging filter that adds request_id to log records.

    This filter reads the request_id from the ContextVar set by set_request_context()
    and adds it to each log record, making it available in the log format string.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        """
        Add request_id to the log record.

        Args:
            record: The log record to modify

        Returns:
            True (always allow the record to be logged)
        """
        try:
            from shared.telemetry.context.span import get_request_id

            request_id = get_request_id()
            record.request_id = request_id if request_id else "-"
        except ImportError:
            # If telemetry module is not available, use placeholder
            record.request_id = "-"
        except Exception:
            # Fallback for any other errors
            record.request_id = "-"

        return True


def _create_file_handler(log_format: str, datefmt: str) -> logging.Handler | None:
    """
    Create a TimedRotatingFileHandler that rotates every natural hour.

    File logging is controlled by settings.LOG_FILE_ENABLED (default: False).

    Log directory is configured via settings.LOG_DIR (default: ./logs).
    Returns None if file logging is disabled or if the directory cannot be created.

    Rotation suffix format: info.log.YYYYMMDD-HH
    e.g.  info.log.20260306-10
    """
    # Check if file logging is enabled (default: disabled)
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

    log_file = os.path.join(log_dir, "info.log")
    file_handler = HourlyRotatingFileHandler(
        filename=log_file,
        when="h",
        interval=1,
        backupCount=0,
        encoding="utf-8",
        utc=False,
    )
    # Override the default suffix so archived files look like:
    #   info.log.20260306-10
    file_handler.suffix = "%Y%m%d-%H"
    file_handler.setFormatter(logging.Formatter(log_format, datefmt=datefmt))
    file_handler.setLevel(logging.DEBUG)
    file_handler.addFilter(RequestIdFilter())
    return file_handler


def setup_logging() -> None:
    """Configure logging format with request_id support."""
    # Get log level from environment variable
    # LOG_LEVEL can be set to DEBUG, INFO, WARNING, ERROR, CRITICAL
    log_level_str = os.environ.get("LOG_LEVEL", "INFO").upper()
    log_level = getattr(logging, log_level_str, logging.INFO)

    # Create a custom formatter that includes request_id
    log_format = (
        "%(asctime)s %(levelname)-4s [%(request_id)s] "
        "%(pathname)s:%(lineno)d : %(message)s"
    )
    datefmt = "%Y-%m-%d %H:%M:%S"

    # Console handler (keep existing behaviour)
    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setFormatter(logging.Formatter(log_format, datefmt=datefmt))
    console_handler.setLevel(logging.DEBUG)
    console_handler.addFilter(RequestIdFilter())

    # File handler with hourly rotation
    file_handler = _create_file_handler(log_format, datefmt)

    # Configure root logger
    root_logger = logging.getLogger()
    root_logger.setLevel(log_level)
    root_logger.handlers.clear()
    root_logger.addHandler(console_handler)
    if file_handler is not None:
        root_logger.addHandler(file_handler)

    # IMPORTANT: Also set level for 'app' logger hierarchy
    # This ensures all app.* loggers inherit the correct level
    app_logger = logging.getLogger("app")
    app_logger.setLevel(log_level)

    # Set third-party library log levels
    for name in ["uvicorn", "uvicorn.error", "fastapi"]:
        logger = logging.getLogger(name)
        logger.handlers.clear()
        logger.propagate = True

    logging.getLogger("uvicorn.access").handlers.clear()
    logging.getLogger("uvicorn.access").propagate = False

    # Log the configured level for debugging
    root_logger.info(f"Logging configured with level: {log_level_str} ({log_level})")
