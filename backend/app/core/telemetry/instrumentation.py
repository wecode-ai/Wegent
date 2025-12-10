# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
OpenTelemetry instrumentation setup for the backend service.

This module wraps the shared telemetry instrumentation module
and provides backend-specific configuration (SQLAlchemy support).
"""

import logging
from typing import Any

from fastapi import FastAPI


def setup_opentelemetry_instrumentation(
    app: FastAPI, logger: logging.Logger, engine: Any = None
) -> None:
    """
    Setup OpenTelemetry instrumentation for the backend service.

    This function wraps the shared telemetry instrumentation module
    and enables SQLAlchemy instrumentation for database query tracing.

    Args:
        app: FastAPI application instance
        logger: Logger instance
        engine: SQLAlchemy engine instance (optional, will import from session if not provided)
    """
    # Import the database engine if not provided
    if engine is None:
        try:
            from app.db.session import engine as db_engine

            engine = db_engine
        except ImportError:
            logger.warning("Could not import database engine for SQLAlchemy instrumentation")

    # Use the shared telemetry instrumentation module
    try:
        from shared.telemetry.instrumentation import (
            setup_opentelemetry_instrumentation as shared_setup,
        )

        shared_setup(
            app=app,
            logger=logger,
            enable_sqlalchemy=True,
            sqlalchemy_engine=engine,
        )
    except ImportError:
        logger.warning("Shared telemetry instrumentation module not available")