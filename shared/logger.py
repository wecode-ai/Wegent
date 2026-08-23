#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

"""
Common logging module, configures and provides logging functionality for the application.

Supports automatic request_id injection into log messages via ContextVar.
"""

import atexit
import logging
import math
import multiprocessing
import os
import sys
import time
from logging.handlers import QueueHandler, QueueListener, TimedRotatingFileHandler
from typing import Optional


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
            from shared.telemetry.context import get_request_id

            request_id = get_request_id()
            record.request_id = request_id if request_id else "-"
        except ImportError:
            # If telemetry module is not available, use placeholder
            record.request_id = "-"
        except Exception:
            # Fallback for any other errors
            record.request_id = "-"

        return True


class NonBlockingStreamHandler(logging.StreamHandler):
    """
    Custom stream handler that handles BlockingIOError gracefully
    """

    def emit(self, record):
        """
        Emit a record with error handling for BlockingIOError
        """
        try:
            super().emit(record)
        except BlockingIOError:
            # Silently ignore blocking errors to prevent application crashes
            pass
        except Exception:
            # Handle other exceptions gracefully
            pass


class HourlyRotatingFileHandler(TimedRotatingFileHandler):
    """Rotate on natural hour boundaries with multi-process locking."""

    def computeRollover(self, currentTime: float) -> float:
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
        import fcntl

        lock_path = self.baseFilename + ".lock"
        with open(lock_path, "a") as lock_file:
            fcntl.flock(lock_file, fcntl.LOCK_EX)
            try:
                self._do_rollover_locked()
            finally:
                fcntl.flock(lock_file, fcntl.LOCK_UN)

    def _do_rollover_locked(self) -> None:
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

        self.stream = self._open()
        now = int(time.time())
        new_rollover = self.computeRollover(now)
        while new_rollover <= now:
            new_rollover += self.interval
        self.rolloverAt = new_rollover


_FILE_HANDLER: Optional[HourlyRotatingFileHandler] = None
_FILE_HANDLER_PATH: Optional[str] = None


def _logger_has_handler(logger: logging.Logger, handler: logging.Handler) -> bool:
    return any(existing is handler for existing in logger.handlers)


def _file_log_handler(
    *,
    level: int,
    format: str,
    datefmt: str,
    include_request_id: bool,
) -> Optional[HourlyRotatingFileHandler]:
    """Return the shared hourly file handler when file logging is configured."""
    global _FILE_HANDLER, _FILE_HANDLER_PATH

    log_file = os.environ.get("WEGENT_LOG_FILE_PATH", "").strip()
    if not log_file:
        return None

    if _FILE_HANDLER is not None and _FILE_HANDLER_PATH != log_file:
        try:
            _FILE_HANDLER.close()
        finally:
            _FILE_HANDLER = None
            _FILE_HANDLER_PATH = None

    if _FILE_HANDLER is None:
        log_dir = os.path.dirname(log_file)
        if log_dir:
            os.makedirs(log_dir, exist_ok=True)
        handler = HourlyRotatingFileHandler(
            filename=log_file,
            when="h",
            interval=1,
            backupCount=0,
            encoding="utf-8",
            utc=False,
        )
        handler.suffix = "%Y%m%d-%H%z"
        handler.setFormatter(logging.Formatter(format, datefmt))
        if include_request_id:
            handler.addFilter(RequestIdFilter())
        _FILE_HANDLER = handler
        _FILE_HANDLER_PATH = log_file

    _FILE_HANDLER.setLevel(level)
    return _FILE_HANDLER


def configure_file_logging(
    log_file: str,
    *,
    level: int = logging.INFO,
) -> None:
    """Enable shared hourly file logging for existing and future loggers."""
    os.environ["WEGENT_LOG_FILE_PATH"] = log_file

    handler = _file_log_handler(
        level=level,
        format="%(asctime)s - [%(request_id)s] - [%(name)s] - %(levelname)s - %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
        include_request_id=True,
    )
    if handler is None:
        return

    loggers = [logging.getLogger()]
    for candidate in logging.Logger.manager.loggerDict.values():
        if isinstance(candidate, logging.Logger):
            loggers.append(candidate)

    for current_logger in loggers:
        if current_logger.handlers and not _logger_has_handler(current_logger, handler):
            current_logger.addHandler(handler)


def _stop_queue_listener_safely(listener: QueueListener) -> None:
    """Stop a QueueListener once, ignoring duplicate shutdown calls."""
    if getattr(listener, "_thread", None) is None:
        return

    try:
        listener.stop()
    except AttributeError as exc:
        if getattr(listener, "_thread", None) is None:
            return
        raise


def _log_stream():
    """Return the configured logging stream."""
    value = os.environ.get("WEGENT_LOG_TO_STDERR", "").strip().lower()
    if value in {"1", "true", "yes", "on"}:
        return sys.stderr
    return sys.stdout


def setup_logger(
    name,
    level=logging.INFO,
    format="%(asctime)s - [%(request_id)s] - [in %(pathname)s:%(lineno)d] - %(levelname)s - %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
    use_multiprocessing_safe=True,
    include_request_id=True,
):
    """
    Configure and return a logger instance

    If environment variable LOG_LEVEL is set to DEBUG, force log level to DEBUG.

    Args:
        name: Logger name
        level: Logging level, default is INFO
        format: Log message format, default includes line number and request_id
        datefmt: Date format for timestamps
        use_multiprocessing_safe: Whether to use multiprocessing-safe logging
        include_request_id: Whether to include request_id in log format (default: True)

    Returns:
        logging.Logger: Configured logger instance
    """
    # Check environment variable for log level
    env_log_level = os.environ.get("LOG_LEVEL")
    if env_log_level and env_log_level.upper() == "DEBUG":
        level = logging.DEBUG

    # Get or create logger
    logger = logging.getLogger(name)

    # Prevent adding duplicate handlers
    if logger.handlers:
        logger.setLevel(level)
        file_handler = _file_log_handler(
            level=level,
            format=format,
            datefmt=datefmt,
            include_request_id=include_request_id,
        )
        if file_handler is not None and not _logger_has_handler(logger, file_handler):
            logger.addHandler(file_handler)
        return logger

    # Set logger level
    logger.setLevel(level)

    # Prevent propagation to root logger to avoid duplicate logs
    logger.propagate = False

    formatter = logging.Formatter(format, datefmt)
    handler_configured = False

    # If multiprocessing-safe logging is requested and we're in a multiprocessing context.
    # Skip for PyInstaller frozen binaries: they are single-process and QueueListener
    # daemon threads cause Fatal Python error (SIGABRT) on shutdown.
    if (
        use_multiprocessing_safe
        and not getattr(sys, "frozen", False)
        and hasattr(os, "getppid")
        and os.getppid() != 1
    ):
        try:
            log_queue = multiprocessing.Queue()
            queue_handler = QueueHandler(log_queue)
            queue_handler.setLevel(level)

            # Add RequestIdFilter to queue handler
            if include_request_id:
                queue_handler.addFilter(RequestIdFilter())

            listener_handler = NonBlockingStreamHandler(_log_stream())
            listener_handler.setLevel(level)
            listener_handler.setFormatter(formatter)

            listener = QueueListener(log_queue, listener_handler)
            listener.start()
            atexit.register(_stop_queue_listener_safely, listener)

            logger.addHandler(queue_handler)
            logger._queue_listener = listener
            handler_configured = True

        except Exception:
            # If multiprocessing setup fails, fall back to standard logging
            handler_configured = False

    if not handler_configured:
        console_handler = NonBlockingStreamHandler(_log_stream())
        console_handler.setLevel(level)
        console_handler.setFormatter(formatter)

        # Add RequestIdFilter to console handler
        if include_request_id:
            console_handler.addFilter(RequestIdFilter())

        logger.addHandler(console_handler)

    file_handler = _file_log_handler(
        level=level,
        format=format,
        datefmt=datefmt,
        include_request_id=include_request_id,
    )
    if file_handler is not None and not _logger_has_handler(logger, file_handler):
        logger.addHandler(file_handler)

    return logger
