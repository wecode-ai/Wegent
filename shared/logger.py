#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

"""
Common logging module, configures and provides logging functionality for the application.

Supports automatic request_id injection into log messages via ContextVar.
"""

import logging
import multiprocessing
import os
import sys
from logging.handlers import QueueHandler, QueueListener
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
        # Logger already configured, just update level and return
        logger.setLevel(level)
        return logger

    # Set logger level
    logger.setLevel(level)

    # Prevent propagation to root logger to avoid duplicate logs
    logger.propagate = False

    formatter = logging.Formatter(format, datefmt)
    handler_configured = False

    # If multiprocessing-safe logging is requested and we're in a multiprocessing context
    if use_multiprocessing_safe and hasattr(os, "getppid") and os.getppid() != 1:
        try:
            log_queue = multiprocessing.Queue()
            queue_handler = QueueHandler(log_queue)
            queue_handler.setLevel(level)

            # Add RequestIdFilter to queue handler
            if include_request_id:
                queue_handler.addFilter(RequestIdFilter())

            listener_handler = NonBlockingStreamHandler(sys.stdout)
            listener_handler.setLevel(level)
            listener_handler.setFormatter(formatter)

            listener = QueueListener(log_queue, listener_handler)
            listener.start()

            logger.addHandler(queue_handler)
            logger._queue_listener = listener
            handler_configured = True

        except Exception:
            # If multiprocessing setup fails, fall back to standard logging
            handler_configured = False

    if not handler_configured:
        console_handler = NonBlockingStreamHandler(sys.stdout)
        console_handler.setLevel(level)
        console_handler.setFormatter(formatter)

        # Add RequestIdFilter to console handler
        if include_request_id:
            console_handler.addFilter(RequestIdFilter())

        logger.addHandler(console_handler)

    return logger
