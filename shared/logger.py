#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

"""
Common logging module, configures and provides logging functionality for the application
"""

import logging
import os
import sys
from logging.handlers import QueueHandler, QueueListener
import multiprocessing
from typing import Optional

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

def setup_logger(name, level=logging.INFO,
                format='%(asctime)s - [in %(pathname)s:%(lineno)d] - %(levelname)s - %(message)s',
                datefmt='%Y-%m-%d %H:%M:%S',
                use_multiprocessing_safe=True):
    """
    Configure and return a logger instance

    If environment variable LOG_LEVEL is set to DEBUG, force log level to DEBUG.

    Args:
        name: Logger name
        level: Logging level, default is INFO
        format: Log message format, default includes line number
        datefmt: Date format for timestamps
        use_multiprocessing_safe: Whether to use multiprocessing-safe logging

    Returns:
        logging.Logger: Configured logger instance
    """
    # Check environment variable for log level
    env_log_level = os.environ.get("LOG_LEVEL")
    if env_log_level and env_log_level.upper() == "DEBUG":
        level = logging.DEBUG

    # Configure logging with non-blocking handler
    logging.basicConfig(
        level=level,
        format=format,
        datefmt=datefmt,
        handlers=[NonBlockingStreamHandler(sys.stdout)]
    )

    logger = logging.getLogger(name)

    # If multiprocessing-safe logging is requested and we're in a multiprocessing context
    if use_multiprocessing_safe and hasattr(os, 'getppid') and os.getppid() != 1:
        # Check if we're in a subprocess
        try:
            # Use a QueueHandler to avoid BlockingIOError in multiprocessing
            if not any(isinstance(handler, QueueHandler) for handler in logger.handlers):
                # Create a queue for log messages
                log_queue = multiprocessing.Queue()

                # Create a queue handler for this logger
                queue_handler = QueueHandler(log_queue)
                logger.addHandler(queue_handler)

                # Create a listener that will write to the console
                console_handler = NonBlockingStreamHandler(sys.stdout)
                console_handler.setFormatter(logging.Formatter(format, datefmt))

                # Create and start the listener
                listener = QueueListener(log_queue, console_handler)
                listener.start()

                # Store the listener reference to prevent garbage collection
                logger._queue_listener = listener

        except Exception:
            # If multiprocessing setup fails, fall back to standard logging
            pass

    return logger