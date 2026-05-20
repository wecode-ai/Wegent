"""Logging configuration for the knowledge_doc_converter Celery worker.

Provides request_id-aware log formatting and hourly-rotating file handlers,
following the same patterns as the backend and knowledge_runtime services.

Celery rebuilds logger handlers via its own signals, so file handlers added
during initial setup would be lost. This module hooks into Celery's
after_setup_logger / after_setup_task_logger signals to re-apply the format
and re-attach file handlers after Celery reconfigures logging.
"""

import logging
import math
import os
import sys
import time
from logging.handlers import TimedRotatingFileHandler


class HourlyRotatingFileHandler(TimedRotatingFileHandler):
    """TimedRotatingFileHandler with clock-snapped rotation and multi-process safety.

    1. Clock-snapped rotation: rolls over exactly on the hour boundary (HH:00:00)
       instead of startTime + 3600, so log files reliably map to a single clock-hour.

    2. Multi-process safety: acquires an exclusive flock before rotating so that
       concurrent Celery workers sharing the same log file do not corrupt each
       other's output or produce duplicate rotated files.
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

        t = self.rolloverAt - self.interval
        timeTuple = time.localtime(t) if not self.utc else time.gmtime(t)
        dfn = self.rotation_filename(
            self.baseFilename + "." + time.strftime(self.suffix, timeTuple)
        )

        if not os.path.exists(dfn):
            self.rotate(self.baseFilename, dfn)

        self.stream = self._open()
        now = int(time.time())
        new_rollover = self.computeRollover(now)
        while new_rollover <= now:
            new_rollover += self.interval
        self.rolloverAt = new_rollover


class RequestIdFilter(logging.Filter):
    """A logging filter that adds request_id to log records.

    Reads the request_id from the ContextVar set by set_request_context()
    and adds it to each log record, making it available in the log format string.
    Falls back to "-" if telemetry module is unavailable.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        """Add request_id to the log record."""
        try:
            from shared.telemetry.context.span import get_request_id

            request_id = get_request_id()
            record.request_id = request_id if request_id else "-"
        except ImportError:
            record.request_id = "-"
        except Exception:
            record.request_id = "-"
        return True


# Shared log format across all services
LOG_FORMAT = (
    "%(asctime)s %(levelname)-4s [%(request_id)s] "
    "%(pathname)s:%(lineno)d : %(message)s"
)
LOG_DATEFMT = "%Y-%m-%d %H:%M:%S"


def _create_file_handler(
    log_dir: str, filename: str, level: int = logging.DEBUG
) -> logging.Handler | None:
    """Create an HourlyRotatingFileHandler that rotates every natural hour.

    Rotation suffix format: <filename>.YYYYMMDD-HH
    e.g. info.log.20260306-10

    Args:
        log_dir: Directory for log files.
        filename: Log file name (e.g., "info.log", "error.log").
        level: Logging level for this handler.

    Returns:
        A configured handler, or None if the directory cannot be created.
    """
    try:
        os.makedirs(log_dir, exist_ok=True)
    except OSError as exc:
        print(
            f"[logging] WARNING: cannot create log directory {log_dir!r}: {exc}; "
            "falling back to console-only logging.",
            file=sys.stderr,
        )
        return None

    log_file = os.path.join(log_dir, filename)
    file_handler = HourlyRotatingFileHandler(
        filename=log_file,
        when="h",
        interval=1,
        backupCount=0,
        encoding="utf-8",
        utc=False,
    )
    file_handler.suffix = "%Y%m%d-%H"
    file_handler.setFormatter(logging.Formatter(LOG_FORMAT, datefmt=LOG_DATEFMT))
    file_handler.setLevel(level)
    file_handler.addFilter(RequestIdFilter())
    return file_handler


def setup_logging(
    log_file_enabled: bool = False,
    log_dir: str = "./logs",
    log_level: str = "INFO",
) -> None:
    """Configure logging format with request_id support and optional file output.

    For Celery workers, this sets up the root logger. Celery's own signals
    (after_setup_logger, after_setup_task_logger) will later re-apply this
    format to Celery-managed loggers.

    Args:
        log_file_enabled: Whether to write logs to rotating files.
        log_dir: Directory for log files (only used if log_file_enabled).
        log_level: Log level string (DEBUG, INFO, WARNING, ERROR, CRITICAL).
    """
    log_level_val = getattr(logging, log_level.upper(), logging.INFO)

    formatter = logging.Formatter(LOG_FORMAT, datefmt=LOG_DATEFMT)

    # Console handler
    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setFormatter(formatter)
    console_handler.setLevel(logging.DEBUG)
    console_handler.addFilter(RequestIdFilter())

    # Configure root logger
    root_logger = logging.getLogger()
    root_logger.setLevel(log_level_val)
    root_logger.handlers.clear()
    root_logger.addHandler(console_handler)

    # File handlers
    if log_file_enabled:
        info_handler = _create_file_handler(log_dir, "info.log", logging.DEBUG)
        error_handler = _create_file_handler(log_dir, "error.log", logging.ERROR)
        if info_handler is not None:
            root_logger.addHandler(info_handler)
        if error_handler is not None:
            root_logger.addHandler(error_handler)

    # Suppress verbose third-party loggers
    for name in ("httpx", "httpcore", "urllib3", "botocore", "boto3"):
        logging.getLogger(name).setLevel(logging.WARNING)

    root_logger.info(
        f"Logging configured: level={log_level.upper()}, "
        f"file_enabled={log_file_enabled}, dir={log_dir}"
    )


def apply_celery_format(
    logger: logging.Logger, log_file_enabled: bool, log_dir: str
) -> None:
    """Apply the converter log format to a Celery-managed logger.

    Celery rebuilds logger handlers via its own signals, so file handlers
    added during initial setup would be lost. This function re-applies the
    format and re-attaches file handlers after Celery reconfigures logging.

    Args:
        logger: The Celery logger to configure.
        log_file_enabled: Whether to attach file handlers.
        log_dir: Directory for log files.
    """
    formatter = logging.Formatter(LOG_FORMAT, datefmt=LOG_DATEFMT)

    # Re-format existing (console) handlers
    for handler in logger.handlers:
        handler.setFormatter(formatter)
        # Remove any existing RequestIdFilter to avoid duplicates
        handler.filters = [
            f for f in handler.filters if not isinstance(f, RequestIdFilter)
        ]
        handler.addFilter(RequestIdFilter())

    # Attach file handler if enabled and not already present
    if log_file_enabled:
        already_has_file = any(
            isinstance(h, HourlyRotatingFileHandler) for h in logger.handlers
        )
        if not already_has_file:
            info_handler = _create_file_handler(log_dir, "info.log", logging.DEBUG)
            if info_handler is not None:
                logger.addHandler(info_handler)
