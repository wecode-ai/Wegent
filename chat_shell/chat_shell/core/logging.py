# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Logging configuration for Chat Shell Service."""

import logging
import sys


def setup_logging() -> None:
    """Configure logging format for Chat Shell Service."""

    # Create a custom formatter
    log_format = (
        "%(asctime)s %(levelname)-4s [chat-shell] %(filename)s:%(lineno)d : %(message)s"
    )

    # Create handler
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(logging.Formatter(log_format, datefmt="%Y-%m-%d %H:%M:%S"))

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
