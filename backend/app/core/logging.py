# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import logging
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


def setup_logging() -> None:
    """Configure logging format with request_id support"""

    # Create a custom formatter that includes request_id
    log_format = "%(asctime)s %(levelname)-4s [%(request_id)s] : %(message)s"

    # Create handler
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(logging.Formatter(log_format, datefmt="%Y-%m-%d %H:%M:%S"))

    # Add the RequestIdFilter to the handler
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
