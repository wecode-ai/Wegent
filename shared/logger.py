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
    if use_multiprocessing_safe and hasattr(os, 'getppid') and os.getppid() != 1:
        try:
            log_queue = multiprocessing.Queue()
            queue_handler = QueueHandler(log_queue)
            queue_handler.setLevel(level)

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
        logger.addHandler(console_handler)

    return logger
