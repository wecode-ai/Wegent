# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import logging
import sys
from typing import Any

import structlog
from structlog.types import EventDict, Processor

def drop_color_message_key(_, __, event_dict: EventDict) -> EventDict:
    """Remove color_message key"""
    event_dict.pop("color_message", None)
    return event_dict

def setup_logging() -> None:
    """Configure structured logging"""
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.processors.StackInfoRenderer(),
            drop_color_message_key,
            structlog.processors.format_exc_info,
            structlog.dev.ConsoleRenderer(colors=False, pad_level=False)  # Disable space padding and logger name
        ],
        wrapper_class=structlog.stdlib.BoundLogger,
        logger_factory=structlog.stdlib.LoggerFactory(),
        cache_logger_on_first_use=True,
    )

    # Configure standard library logging
    logging.basicConfig(
        format="%(message)s",
        stream=sys.stdout,
        level=logging.INFO,
    )

    # Set third-party library log levels
    for name in ["uvicorn", "uvicorn.error", "fastapi"]:
        logging.getLogger(name).handlers.clear()
        logging.getLogger(name).propagate = True

    logging.getLogger("uvicorn.access").handlers.clear()
    logging.getLogger("uvicorn.access").propagate = False