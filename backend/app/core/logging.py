# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import logging
import logging.config
import os
import sys
from logging.handlers import TimedRotatingFileHandler

from app.core.config import settings


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
    file_handler = TimedRotatingFileHandler(
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
