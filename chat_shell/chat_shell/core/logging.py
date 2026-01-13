# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Logging configuration for Chat Shell Service."""

import logging
import sys


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

    # Create a custom formatter with request_id
    log_format = "%(asctime)s %(levelname)-4s [%(request_id)s] %(filename)s:%(lineno)d : %(message)s"

    # Create handler
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(logging.Formatter(log_format, datefmt="%Y-%m-%d %H:%M:%S"))
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
