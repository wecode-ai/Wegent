# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import logging
import logging.config
import os
import sys


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

    # Create handler
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(logging.Formatter(log_format, datefmt="%Y-%m-%d %H:%M:%S"))
    handler.setLevel(logging.DEBUG)
    handler.addFilter(RequestIdFilter())

    # Configure root logger
    root_logger = logging.getLogger()
    root_logger.setLevel(log_level)
    root_logger.handlers.clear()
    root_logger.addHandler(handler)

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
