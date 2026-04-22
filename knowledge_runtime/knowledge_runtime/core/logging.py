# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Logging configuration for knowledge_runtime service."""

from __future__ import annotations

import logging
import os
import sys
from logging.handlers import TimedRotatingFileHandler


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


def _create_file_handler(
    log_dir: str,
    filename: str,
    level: int,
    log_format: str,
    datefmt: str,
) -> logging.Handler:
    """
    Create a TimedRotatingFileHandler that rotates every natural hour.

    Args:
        log_dir: Directory to store log files
        filename: Name of the log file
        level: Log level for this handler
        log_format: Format string for log messages
        datefmt: Date format string

    Returns:
        Configured TimedRotatingFileHandler instance

    Rotation suffix format: info.log.YYYYMMDD-HH
    e.g.  info.log.20260419-10
    """
    os.makedirs(log_dir, exist_ok=True)

    log_file = os.path.join(log_dir, filename)
    handler = TimedRotatingFileHandler(
        filename=log_file,
        when="h",
        interval=1,
        backupCount=0,
        encoding="utf-8",
        utc=False,
    )
    # Override the default suffix so archived files look like:
    #   info.log.20260419-10
    handler.suffix = "%Y%m%d-%H"
    handler.setFormatter(logging.Formatter(log_format, datefmt=datefmt))
    handler.setLevel(level)
    handler.addFilter(RequestIdFilter())
    return handler


def setup_logging(log_file_enabled: bool, log_dir: str, log_level: str) -> None:
    """
    Configure logging system for knowledge_runtime service.

    When log_file_enabled is True, logs are written to files only (not console):
    - access.log: HTTP access logs (uvicorn.access)
    - info.log: Application logs (DEBUG and above)
    - error.log: Error logs (ERROR and above only)

    When log_file_enabled is False, logs are written to console only.

    Args:
        log_file_enabled: Whether to enable file logging
        log_dir: Directory to store log files
        log_level: Log level string (DEBUG, INFO, WARNING, ERROR, CRITICAL)
    """
    level = getattr(logging, log_level.upper(), logging.INFO)

    log_format = (
        "%(asctime)s %(levelname)-4s [%(request_id)s] "
        "%(pathname)s:%(lineno)d : %(message)s"
    )
    datefmt = "%Y-%m-%d %H:%M:%S"

    root_logger = logging.getLogger()
    root_logger.setLevel(level)
    root_logger.handlers.clear()

    if log_file_enabled:
        # info.log - records application logs (DEBUG and above)
        info_handler = _create_file_handler(
            log_dir, "info.log", logging.DEBUG, log_format, datefmt
        )
        root_logger.addHandler(info_handler)

        # error.log - records ERROR and above only
        error_handler = _create_file_handler(
            log_dir, "error.log", logging.ERROR, log_format, datefmt
        )
        root_logger.addHandler(error_handler)

        # access.log - HTTP access logs (separate from info.log)
        access_handler = _create_file_handler(
            log_dir, "access.log", logging.DEBUG, log_format, datefmt
        )
        access_logger = logging.getLogger("uvicorn.access")
        access_logger.handlers.clear()
        access_logger.addHandler(access_handler)
        access_logger.propagate = False  # Don't propagate to root logger
    else:
        # File logging disabled, use console output
        console_handler = logging.StreamHandler(sys.stdout)
        console_handler.setFormatter(logging.Formatter(log_format, datefmt=datefmt))
        console_handler.setLevel(logging.DEBUG)
        console_handler.addFilter(RequestIdFilter())
        root_logger.addHandler(console_handler)

        # Access logs to console as well
        access_logger = logging.getLogger("uvicorn.access")
        access_logger.handlers.clear()
        access_logger.propagate = True

    # Configure third-party library log levels
    for name in ["uvicorn", "uvicorn.error", "fastapi"]:
        logger = logging.getLogger(name)
        logger.handlers.clear()
        logger.propagate = True

    # Suppress verbose httpx logs
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)

    # Log the configuration
    root_logger.info(
        f"Logging configured: level={log_level}, file_enabled={log_file_enabled}, "
        f"log_dir={log_dir if log_file_enabled else 'N/A'}"
    )
