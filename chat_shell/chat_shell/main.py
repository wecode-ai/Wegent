# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Chat Shell Service - FastAPI Application.

This is the main entry point for the Chat Shell HTTP Service.

Supports three deployment modes:
1. HTTP Mode: Standalone HTTP service with /v1/response API
2. Package Mode: Imported as Python package by Backend
3. CLI Mode: Command-line interface for interactive chat

Usage:
    # HTTP Mode (default)
    uvicorn chat_shell.main:app --host 0.0.0.0 --port 8001

    # Or using CLI
    chat-shell serve --port 8001
"""

import json
import logging
import os
import time
import uuid
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware

# Import telemetry config (always available)
from shared.telemetry.config import get_otel_config
from starlette.responses import StreamingResponse

from chat_shell import __version__
from chat_shell.core.config import settings
from chat_shell.core.logging import setup_logging
from chat_shell.storage import StorageProvider, StorageType, create_storage_provider

# Initialize logging at module level
setup_logging()
logger = logging.getLogger(__name__)

# Global storage provider
_storage_provider: Optional[StorageProvider] = None
_start_time = time.time()


async def get_storage_provider() -> StorageProvider:
    """Get the global storage provider."""
    global _storage_provider
    if _storage_provider is None:
        raise RuntimeError("Storage provider not initialized")
    return _storage_provider


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan handler."""
    global _storage_provider, _start_time

    # Startup
    _start_time = time.time()
    logger.info("Starting Chat Shell Service...")
    logger.info(f"Version: {__version__}")
    logger.info(f"Environment: {settings.ENVIRONMENT}")
    logger.info(f"Mode: {settings.CHAT_SHELL_MODE}")
    logger.info(f"Storage: {settings.STORAGE_TYPE}")

    # Set DATA_TABLE_CONFIG to environment variable for os.getenv() access
    if settings.DATA_TABLE_CONFIG:
        os.environ["DATA_TABLE_CONFIG"] = settings.DATA_TABLE_CONFIG
        logger.info("DATA_TABLE_CONFIG loaded from settings and set to environment")

    # Initialize storage provider
    storage_type = StorageType(settings.STORAGE_TYPE)
    storage_kwargs = {}

    if storage_type == StorageType.SQLITE:
        storage_kwargs["db_path"] = settings.SQLITE_DB_PATH
    elif storage_type == StorageType.REMOTE:
        storage_kwargs["base_url"] = settings.REMOTE_STORAGE_URL
        storage_kwargs["auth_token"] = settings.REMOTE_STORAGE_TOKEN

    _storage_provider = create_storage_provider(storage_type, **storage_kwargs)
    await _storage_provider.initialize()
    logger.info(f"Storage provider initialized: {storage_type.value}")

    yield

    # Shutdown
    logger.info("Shutting down Chat Shell Service...")

    # Graceful shutdown: wait for active streams to complete
    from chat_shell.api.v1.response import _active_streams
    from chat_shell.core.shutdown import shutdown_manager

    if not shutdown_manager.is_shutting_down:
        await shutdown_manager.initiate_shutdown()

    active_count = shutdown_manager.get_active_stream_count()
    if active_count > 0:
        logger.info(
            f"Waiting for {active_count} active streams to complete "
            f"(timeout: {settings.GRACEFUL_SHUTDOWN_TIMEOUT}s)..."
        )
        streams_completed = await shutdown_manager.wait_for_streams(
            timeout=settings.GRACEFUL_SHUTDOWN_TIMEOUT
        )
        if not streams_completed:
            remaining = shutdown_manager.get_active_stream_count()
            logger.warning(
                f"Timeout waiting for streams. Cancelling {remaining} remaining streams..."
            )
            cancelled = await shutdown_manager.cancel_all_streams(_active_streams)
            logger.info(f"Cancelled {cancelled} streams")
    else:
        logger.info("No active streams, proceeding with shutdown")

    # Shutdown OpenTelemetry
    from shared.telemetry.core import is_telemetry_enabled, shutdown_telemetry

    if get_otel_config().enabled and is_telemetry_enabled():
        shutdown_telemetry()
        logger.info("OpenTelemetry shutdown completed")

    # Close storage
    if _storage_provider:
        await _storage_provider.close()
        logger.info("Storage provider closed")

    logger.info("Chat Shell Service stopped")


def create_app(
    storage_type: Optional[str] = None,
    **kwargs,
) -> FastAPI:
    """
    Create and configure the FastAPI application.

    Args:
        storage_type: Override storage type (memory, sqlite, remote)
        **kwargs: Additional configuration options
            - db_path: SQLite database path
            - remote_url: Remote storage URL
            - remote_token: Remote storage auth token

    Returns:
        Configured FastAPI application
    """
    # Override settings if provided
    if storage_type:
        settings.STORAGE_TYPE = storage_type
    if "db_path" in kwargs:
        settings.SQLITE_DB_PATH = kwargs["db_path"]
    if "remote_url" in kwargs:
        settings.REMOTE_STORAGE_URL = kwargs["remote_url"]
    if "remote_token" in kwargs:
        settings.REMOTE_STORAGE_TOKEN = kwargs["remote_token"]

    app = FastAPI(
        title=settings.PROJECT_NAME,
        version=__version__,
        description="Chat Shell Service - Independent AI Agent Engine with /v1/response API",
        docs_url="/docs" if settings.ENABLE_API_DOCS else None,
        redoc_url="/redoc" if settings.ENABLE_API_DOCS else None,
        openapi_url="/openapi.json" if settings.ENABLE_API_DOCS else None,
        lifespan=lifespan,
    )

    # Add CORS middleware
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # Get OTEL config early for use in middleware
    otel_config = get_otel_config("wegent-chat-shell")

    # CRITICAL: Initialize OpenTelemetry instrumentation BEFORE custom middleware
    # FastAPIInstrumentor adds ASGI-level middleware that extracts trace context
    # from incoming headers and creates spans. This must happen at the ASGI layer
    # BEFORE any HTTP middleware runs, so that trace.get_current_span() returns
    # the correct span with propagated trace context in our custom middleware.
    #
    # Note: @app.middleware("http") uses BaseHTTPMiddleware which runs AFTER
    # ASGI middleware regardless of declaration order. So we initialize OTEL first.
    if otel_config.enabled:
        from shared.telemetry.core import init_telemetry, is_telemetry_enabled

        if not is_telemetry_enabled():
            # Pass all config values from otel_config to init_telemetry
            init_telemetry(
                service_name="wegent-chat-shell",
                enabled=otel_config.enabled,
                otlp_endpoint=otel_config.otlp_endpoint,
                sampler_ratio=otel_config.sampler_ratio,
                metrics_enabled=otel_config.metrics_enabled,
                capture_request_headers=otel_config.capture_request_headers,
                capture_request_body=otel_config.capture_request_body,
                capture_response_headers=otel_config.capture_response_headers,
                capture_response_body=otel_config.capture_response_body,
                max_body_size=otel_config.max_body_size,
            )
            logger.info(
                "OpenTelemetry initialized for chat_shell with endpoint: %s",
                otel_config.otlp_endpoint,
            )

        # Setup OpenTelemetry instrumentation for FastAPI
        from shared.telemetry.instrumentation import setup_opentelemetry_instrumentation

        setup_opentelemetry_instrumentation(app, logger)
        logger.info(
            "OpenTelemetry instrumentation enabled (ASGI-level, before HTTP middleware)"
        )

    # Add exception handler for validation errors (422)
    from fastapi.exceptions import RequestValidationError
    from fastapi.responses import JSONResponse

    @app.exception_handler(RequestValidationError)
    async def validation_exception_handler(
        request: Request, exc: RequestValidationError
    ):
        """Log detailed validation errors for debugging."""
        logger.error(
            "[VALIDATION_ERROR] 422 Unprocessable Entity: %s %s\nErrors: %s",
            request.method,
            request.url.path,
            exc.errors(),
        )
        return JSONResponse(
            status_code=422,
            content={"detail": exc.errors()},
        )

    # HTTP middleware for request context and tracing
    @app.middleware("http")
    async def trace_requests_middleware(request: Request, call_next):
        """Middleware to set up request context and trace attributes."""
        # Skip for health check
        if request.url.path == "/":
            return await call_next(request)

        # Generate request ID
        request_id = str(uuid.uuid4())[:8]
        request.state.request_id = request_id
        start_time = time.time()

        client_ip = request.client.host if request.client else "Unknown"

        # Log traceparent header for debugging distributed tracing
        traceparent = request.headers.get("traceparent")
        logger.debug(
            "[TRACE] traceparent header: %s for %s %s",
            traceparent or "NOT_PRESENT",
            request.method,
            request.url.path,
        )

        # Extract and attach trace context from headers
        # BaseHTTPMiddleware runs in a new async task, so contextvars from
        # OTEL ASGI middleware are not propagated. We need to manually extract
        # and attach the trace context to enable distributed tracing.
        from opentelemetry import context as otel_context
        from opentelemetry.propagate import extract

        headers_dict = dict(request.headers)
        extracted_ctx = extract(headers_dict)
        token = otel_context.attach(extracted_ctx)

        # Set request context for logging (works even without OTEL)
        from shared.telemetry.context import (
            set_request_context,
            set_task_context,
            set_user_context,
        )

        set_request_context(request_id)

        # Capture request body if OTEL enabled and configured
        request_body = None
        if (
            otel_config.enabled
            and otel_config.capture_request_body
            and request.method in ("POST", "PUT", "PATCH")
        ):
            try:
                body_bytes = await request.body()
                if body_bytes:
                    max_body_size = otel_config.max_body_size
                    if len(body_bytes) <= max_body_size:
                        request_body = body_bytes.decode("utf-8", errors="replace")
                    else:
                        request_body = (
                            body_bytes[:max_body_size].decode("utf-8", errors="replace")
                            + f"... [truncated, total size: {len(body_bytes)} bytes]"
                        )
            except Exception as e:
                logger.debug(f"Failed to capture request body: {e}")

        # Add OpenTelemetry span attributes if enabled
        if otel_config.enabled:
            from opentelemetry import trace
            from shared.telemetry.core import is_telemetry_enabled

            if is_telemetry_enabled():
                # Extract session_id, task_id from request body
                if request_body:
                    try:
                        body_json = json.loads(request_body)
                        session_id = body_json.get("session_id")
                        task_id = body_json.get("task_id")
                        subtask_id = body_json.get("subtask_id")
                        if task_id is not None or subtask_id is not None:
                            set_task_context(task_id=task_id, subtask_id=subtask_id)
                        user_id = body_json.get("user_id")
                        if user_id is not None:
                            set_user_context(user_id=str(user_id))
                    except (json.JSONDecodeError, TypeError):
                        pass

                # Add request body to current span
                if request_body:
                    current_span = trace.get_current_span()
                    if current_span and current_span.is_recording():
                        current_span.set_attribute("http.request.body", request_body)

        # Pre-request logging
        logger.info(
            f"request : {request.method} {request.url.path} {request.query_params} {request_id} {client_ip}"
        )

        # Process request
        try:
            response = await call_next(request)
            process_time = (time.time() - start_time) * 1000

            # For streaming responses, wrap the body iterator to log after completion
            if isinstance(response, StreamingResponse):
                original_body_iterator = response.body_iterator

                async def logging_body_iterator():
                    try:
                        async for chunk in original_body_iterator:
                            yield chunk
                    finally:
                        # Log after streaming completes
                        total_time = (time.time() - start_time) * 1000
                        logger.info(
                            f"response: {request.method} {request.url.path} {response.status_code} {total_time:.2f}ms {request_id} (streamed)"
                        )
                        # Detach trace context after streaming completes
                        otel_context.detach(token)

                response.body_iterator = logging_body_iterator()
            else:
                # Post-request logging for non-streaming responses
                logger.info(
                    f"response: {request.method} {request.url.path} {response.status_code} {process_time:.2f}ms {request_id}"
                )
                # Detach trace context for non-streaming responses
                otel_context.detach(token)

            return response
        except Exception:
            # Detach trace context on error
            otel_context.detach(token)
            raise

    # Include v1 response router
    from chat_shell.api.v1.response import router as v1_response_router

    app.include_router(v1_response_router)

    # Include health check router
    from chat_shell.api.health import router as health_router

    app.include_router(health_router)

    # Root endpoint with basic info
    @app.get("/")
    async def root():
        """Root endpoint with basic info."""
        from chat_shell.core.shutdown import shutdown_manager

        return {
            "service": "chat-shell",
            "version": __version__,
            "status": (
                "shutting_down" if shutdown_manager.is_shutting_down else "running"
            ),
            "docs": "/docs" if settings.ENABLE_API_DOCS else None,
        }

    return app


# Create application instance
app = create_app()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "chat_shell.main:app",
        host=settings.HTTP_HOST,
        port=settings.HTTP_PORT,
        reload=settings.ENVIRONMENT == "development",
    )
