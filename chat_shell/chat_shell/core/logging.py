# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Logging configuration for Chat Shell Service."""

import logging
import os
import sys


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


def setup_logging() -> None:
    """Configure logging format for Chat Shell Service."""

    # Create a custom formatter with relative path, request_id and line number for easier debugging
    log_format = "%(asctime)s %(levelname)-4s [%(request_id)s] [%(relativepath)s:%(lineno)d] : %(message)s"

    # Create handler
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(RelativePathFormatter(log_format, datefmt="%Y-%m-%d %H:%M:%S"))
    handler.addFilter(RequestIdFilter())

    # Configure root logger
    root_logger = logging.getLogger()
    root_logger.setLevel(logging.INFO)
    root_logger.handlers.clear()
    root_logger.addHandler(handler)

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
