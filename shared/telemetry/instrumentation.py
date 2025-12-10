# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
OpenTelemetry instrumentation setup for all services.

This module provides auto-instrumentation for:
- FastAPI (HTTP requests/responses)
- SQLAlchemy (database queries) - optional
- HTTPX (async HTTP client)
- Requests (sync HTTP client)
- System metrics (CPU, memory, etc.)
"""

import logging
from typing import Any, Optional


def setup_opentelemetry_instrumentation(
    app: Any,
    logger: Optional[logging.Logger] = None,
    enable_sqlalchemy: bool = False,
    sqlalchemy_engine: Any = None,
) -> None:
    """
    Setup OpenTelemetry instrumentation for a FastAPI service.

    Args:
        app: FastAPI application instance
        logger: Logger instance (optional, will create one if not provided)
        enable_sqlalchemy: Whether to enable SQLAlchemy instrumentation
        sqlalchemy_engine: SQLAlchemy engine instance (required if enable_sqlalchemy is True)
    """
    if logger is None:
        logger = logging.getLogger(__name__)

    _setup_fastapi_instrumentation(app, logger)

    if enable_sqlalchemy:
        _setup_sqlalchemy_instrumentation(logger, sqlalchemy_engine)

    _setup_httpx_instrumentation(logger)
    _setup_requests_instrumentation(logger)
    _setup_system_metrics_instrumentation(logger)


def _setup_fastapi_instrumentation(app: Any, logger: logging.Logger) -> None:
    """Setup FastAPI instrumentation for tracing HTTP requests."""
    try:
        from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor

        FastAPIInstrumentor.instrument_app(app)
        logger.info("✓ FastAPI instrumentation enabled")
    except ImportError:
        logger.debug("FastAPI instrumentation not available (package not installed)")
    except Exception as e:
        logger.warning(f"Failed to setup FastAPI instrumentation: {e}")


def _setup_sqlalchemy_instrumentation(
    logger: logging.Logger, engine: Any = None
) -> None:
    """Setup SQLAlchemy instrumentation for tracing database queries."""
    try:
        from opentelemetry.instrumentation.sqlalchemy import SQLAlchemyInstrumentor

        if engine is None:
            logger.warning(
                "SQLAlchemy instrumentation requested but no engine provided"
            )
            return

        # Handle async engine by getting sync_engine
        actual_engine = getattr(engine, "sync_engine", engine)
        SQLAlchemyInstrumentor().instrument(engine=actual_engine)
        logger.info("✓ SQLAlchemy instrumentation enabled")
    except ImportError:
        logger.debug("SQLAlchemy instrumentation not available (package not installed)")
    except Exception as e:
        logger.warning(f"Failed to setup SQLAlchemy instrumentation: {e}")


def _setup_httpx_instrumentation(logger: logging.Logger) -> None:
    """Setup HTTPX instrumentation for tracing async HTTP client requests."""
    try:
        from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor

        HTTPXClientInstrumentor().instrument()
        logger.info("✓ HTTPX instrumentation enabled")
    except ImportError:
        logger.debug("HTTPX instrumentation not available (package not installed)")
    except Exception as e:
        logger.warning(f"Failed to setup HTTPX instrumentation: {e}")


def _setup_requests_instrumentation(logger: logging.Logger) -> None:
    """Setup Requests instrumentation for tracing sync HTTP client requests."""
    try:
        from opentelemetry.instrumentation.requests import RequestsInstrumentor

        RequestsInstrumentor().instrument()
        logger.info("✓ Requests instrumentation enabled")
    except ImportError:
        logger.debug("Requests instrumentation not available (package not installed)")
    except Exception as e:
        logger.warning(f"Failed to setup Requests instrumentation: {e}")


def _setup_system_metrics_instrumentation(logger: logging.Logger) -> None:
    """Setup system metrics instrumentation for CPU, memory, etc."""
    try:
        from opentelemetry.instrumentation.system_metrics import (
            SystemMetricsInstrumentor,
        )

        SystemMetricsInstrumentor().instrument()
        logger.info("✓ System metrics instrumentation enabled")
    except ImportError:
        logger.debug(
            "System metrics instrumentation not available (package not installed)"
        )
    except Exception as e:
        logger.warning(f"Failed to setup System metrics instrumentation: {e}")
