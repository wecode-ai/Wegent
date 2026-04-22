# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""FastAPI application entry point for knowledge_runtime service."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from knowledge_runtime.api.router import router
from knowledge_runtime.config import get_settings
from knowledge_runtime.core.logging import setup_logging
from shared.models import RemoteRagError

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan handler for startup and shutdown events."""
    settings = get_settings()

    # Initialize logging configuration
    setup_logging(
        log_file_enabled=settings.log_file_enabled,
        log_dir=settings.log_dir,
        log_level=settings.log_level,
    )

    logger.info(
        f"knowledge_runtime starting on {settings.host}:{settings.port}",
    )
    yield
    logger.info("knowledge_runtime shutting down")


app = FastAPI(
    title="Wegent Knowledge Runtime",
    description="HTTP service for RAG operations, called by Backend",
    version="1.0.0",
    lifespan=lifespan,
)


@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """Global exception handler that returns RemoteRagError format."""
    # Log the actual exception with full traceback for diagnostics
    logger.exception(f"Unhandled exception for {request.url}: {exc}")

    # Preserve retryability from exceptions that have this attribute (e.g., ContentFetchError)
    # Fall back to checking for connection/timeout errors
    retryable = getattr(exc, "retryable", None)
    if retryable is None:
        retryable = isinstance(exc, (ConnectionError, TimeoutError))

    error_response = RemoteRagError(
        code="internal_error",
        message="internal server error",
        retryable=retryable,
        details={"exception_type": type(exc).__name__},
    )

    return JSONResponse(
        status_code=500,
        content=error_response.model_dump(mode="json"),
    )


@app.exception_handler(ValueError)
async def value_error_handler(request: Request, exc: ValueError) -> JSONResponse:
    """Handle ValueError as a bad request with RemoteRagError format."""
    logger.warning(f"ValueError for {request.url}: {exc}")

    error_response = RemoteRagError(
        code="invalid_request",
        message=str(exc),
        retryable=False,
    )

    return JSONResponse(
        status_code=400,
        content=error_response.model_dump(mode="json"),
    )


app.include_router(router)


def run() -> None:
    """Run the FastAPI application using uvicorn."""
    import uvicorn

    settings = get_settings()
    uvicorn.run(
        "knowledge_runtime.main:app",
        host=settings.host,
        port=settings.port,
        reload=False,
    )


if __name__ == "__main__":
    run()
