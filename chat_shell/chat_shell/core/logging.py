# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Logging configuration for Chat Shell Service."""

import logging
import os
import sys
from logging.handlers import TimedRotatingFileHandler


class RelativePathFormatter(logging.Formatter):
    """Custom formatter that shows relative path instead of full pathname."""

    def __init__(self, fmt=None, datefmt=None, base_path=None):
        super().__init__(fmt, datefmt)
        # Use provided base_path or detect from current file location
        if base_path is None:
            # Go up from chat_shell/chat_shell/core to chat_shell/
            self.base_path = os.path.dirname(
                os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
            )
        else:
            self.base_path = base_path

    def format(self, record):
        # Convert absolute pathname to relative path
        if record.pathname.startswith(self.base_path):
            record.relativepath = record.pathname[len(self.base_path) + 1 :]
        else:
            record.relativepath = record.pathname
        return super().format(record)


class RequestIdFilter(logging.Filter):
    """
    A logging filter that adds request_id to log records.
    This filter reads the request_id from the ContextVar set by set_request_context()
    and adds it to each log record.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            from shared.telemetry.context import get_request_id

            request_id = get_request_id()
            record.request_id = request_id if request_id else "-"
        except ImportError:
            record.request_id = "-"
        return True


def _create_file_handler(
    formatter: logging.Formatter,
) -> logging.Handler | None:
    """
    Create a TimedRotatingFileHandler that rotates every natural hour.

    File logging is controlled by the LOG_FILE_ENABLED environment variable.
    Set LOG_FILE_ENABLED=true to enable file logging.

    Log directory is read from the LOG_DIR environment variable,
    defaulting to ./logs. Returns None if file logging is disabled
    or if the directory cannot be created.

    Rotation suffix format: info.log.YYYYMMDD-HH
    e.g.  info.log.20260306-10
    """
    # Check if file logging is enabled (default: disabled)
    if os.environ.get("LOG_FILE_ENABLED", "").lower() not in ("true", "1", "yes"):
        return None

    log_dir = os.environ.get("LOG_DIR", "./logs")
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
    file_handler.setFormatter(formatter)
    file_handler.addFilter(RequestIdFilter())
    return file_handler


def setup_logging() -> None:
    """Configure logging format for Chat Shell Service."""

    # Create a custom formatter with relative path, request_id and line number for easier debugging
    log_format = "%(asctime)s %(levelname)-4s [%(request_id)s] [%(relativepath)s:%(lineno)d] : %(message)s"
    datefmt = "%Y-%m-%d %H:%M:%S"
    formatter = RelativePathFormatter(log_format, datefmt=datefmt)

    # Console handler (keep existing behaviour)
    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setFormatter(formatter)
    console_handler.addFilter(RequestIdFilter())

    # File handler with hourly rotation (uses the same formatter)
    file_handler = _create_file_handler(formatter)

    # Configure root logger
    root_logger = logging.getLogger()
    root_logger.setLevel(logging.INFO)
    root_logger.handlers.clear()
    root_logger.addHandler(console_handler)
    if file_handler is not None:
        root_logger.addHandler(file_handler)

    # Set third-party library log levels
    for name in ["uvicorn", "uvicorn.error", "fastapi"]:
        logger = logging.getLogger(name)
        logger.handlers.clear()
        logger.propagate = True

    logging.getLogger("uvicorn.access").handlers.clear()
    logging.getLogger("uvicorn.access").propagate = False

    # Suppress verbose httpx/httpcore request logs
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)
