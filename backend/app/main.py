# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import logging
import sys
import time
import uuid
from contextlib import asynccontextmanager

import redis
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware

from app.api.api import api_router
from app.core.config import settings
from app.core.exceptions import (
    CustomHTTPException,
    RequestValidationError,
    http_exception_handler,
    python_exception_handler,
    validation_exception_handler,
)
from app.core.logging import setup_logging
from app.core.yaml_init import run_yaml_initialization
from app.db.base import Base
from app.db.session import SessionLocal, engine
from app.models import *  # noqa: F401,F403
from app.services.jobs import start_background_jobs, stop_background_jobs

# Redis lock keys for startup operations (migrations + YAML init)
STARTUP_LOCK_KEY = "wegent:startup_lock"
STARTUP_DONE_KEY = "wegent:startup_done"
STARTUP_LOCK_TIMEOUT = 120  # 120 seconds timeout for migrations + YAML init


# Initialize logging at module level for use in lifespan
setup_logging()
_logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Lifespan context manager for FastAPI application.
    Handles startup and shutdown events.
    """
    logger = _logger

    # ==================== STARTUP ====================
    # Initialize chat service HTTP client
    from app.services.chat.base import get_http_client

    await get_http_client()
    logger.info("✓ Chat service HTTP client initialized")

    # Try to get Redis client for distributed locking
    redis_client = None
    try:
        redis_client = redis.from_url(settings.REDIS_URL)
    except Exception as e:
        logger.warning(f"Failed to connect to Redis for startup lock: {e}")

    # Check if startup initialization already done by another worker
    # If INIT_DATA_FORCE is True, skip this check and force re-initialization
    force_init = settings.INIT_DATA_FORCE
    if redis_client and redis_client.exists(STARTUP_DONE_KEY) and not force_init:
        logger.info(
            "Startup initialization already completed by another worker, skipping migrations and YAML init"
        )
    else:
        if force_init:
            logger.info(
                "INIT_DATA_FORCE is enabled, forcing re-initialization of YAML data"
            )
            # Clear the done flag to allow re-initialization
            if redis_client:
                redis_client.delete(STARTUP_DONE_KEY)
        # Try to acquire lock for startup initialization (migrations + YAML)
        acquired_lock = False
        if redis_client:
            acquired_lock = redis_client.set(
                STARTUP_LOCK_KEY, "locked", nx=True, ex=STARTUP_LOCK_TIMEOUT
            )
            if not acquired_lock:
                # Another worker is running startup initialization, wait for completion
                logger.info(
                    "Another worker is running startup initialization, waiting..."
                )
                max_wait = STARTUP_LOCK_TIMEOUT
                waited = 0
                while waited < max_wait:
                    time.sleep(1)
                    waited += 1
                    if redis_client.exists(STARTUP_DONE_KEY):
                        logger.info(
                            "Startup initialization completed by another worker"
                        )
                        break
                    if not redis_client.exists(STARTUP_LOCK_KEY):
                        logger.warning("Lock released but startup not marked as done")
                        break
            else:
                logger.info("Acquired startup initialization lock")

        # Only run startup initialization if we acquired the lock or Redis is not available
        if acquired_lock or not redis_client:
            startup_success = False
            try:
                # Step 1: Run database migrations
                if settings.ENVIRONMENT == "development" and settings.DB_AUTO_MIGRATE:
                    logger.info(
                        "Running database migrations automatically (development mode)..."
                    )
                    try:
                        import os
                        import subprocess

                        # Get the alembic.ini path
                        backend_dir = os.path.dirname(
                            os.path.dirname(os.path.abspath(__file__))
                        )

                        logger.info("Executing Alembic upgrade to head...")

                        # Run Alembic as subprocess to avoid output buffering issues
                        result = subprocess.run(
                            ["alembic", "upgrade", "head"],
                            cwd=backend_dir,
                            capture_output=False,  # Let output go directly to stdout/stderr
                            text=True,
                            check=True,
                        )

                        logger.info("✓ Alembic migrations completed successfully")
                    except subprocess.CalledProcessError as e:
                        logger.error(f"✗ Error running Alembic migrations: {e}")
                        raise
                    except Exception as e:
                        logger.error(
                            f"✗ Unexpected error running Alembic migrations: {e}"
                        )
                        raise
                elif settings.ENVIRONMENT == "production":
                    logger.warning(
                        "Running in production mode. Database migrations must be run manually. "
                        "Please execute 'alembic upgrade head' to apply pending migrations."
                    )
                    # Check migration status
                    try:
                        import os

                        from alembic import command
                        from alembic.config import Config as AlembicConfig
                        from alembic.runtime.migration import MigrationContext
                        from alembic.script import ScriptDirectory

                        backend_dir = os.path.dirname(
                            os.path.dirname(os.path.abspath(__file__))
                        )
                        alembic_ini_path = os.path.join(backend_dir, "alembic.ini")

                        alembic_cfg = AlembicConfig(alembic_ini_path)
                        script = ScriptDirectory.from_config(alembic_cfg)

                        # Get current revision from database
                        with engine.connect() as connection:
                            context = MigrationContext.configure(connection)
                            current_rev = context.get_current_revision()
                            head_rev = script.get_current_head()

                            if current_rev != head_rev:
                                logger.warning(
                                    f"Database migration pending: current={current_rev}, latest={head_rev}. "
                                    "Run 'alembic upgrade head' manually in production."
                                )
                            else:
                                logger.info("Database schema is up to date")
                    except Exception as e:
                        logger.warning(f"Could not check migration status: {e}")
                else:
                    logger.info("Alembic auto-upgrade is disabled")

                # Step 2: Initialize database with YAML configuration
                logger.info("Starting YAML data initialization...")
                db = SessionLocal()
                try:
                    run_yaml_initialization(
                        db, skip_lock=True
                    )  # Skip internal lock since we already have one
                    logger.info("✓ YAML data initialization completed")
                except Exception as e:
                    logger.error(f"✗ Failed to initialize database from YAML: {e}")
                finally:
                    db.close()

                # Mark startup as successful
                startup_success = True
            except Exception as e:
                # Startup failed - do NOT mark as done so next restart will retry
                logger.error(f"✗ Startup initialization failed: {e}")
                startup_success = False
            finally:
                # Only mark startup as done if it was successful
                if redis_client and startup_success:
                    redis_client.set(STARTUP_DONE_KEY, "done", ex=86400)
                    logger.info("Marked startup initialization as done")
                elif redis_client and not startup_success:
                    # Ensure STARTUP_DONE_KEY is deleted if startup failed
                    # This allows the next restart to retry
                    redis_client.delete(STARTUP_DONE_KEY)
                    logger.warning(
                        "Startup failed - cleared done flag to allow retry on next restart"
                    )
                # Release lock
                if redis_client and acquired_lock:
                    redis_client.delete(STARTUP_LOCK_KEY)
                    logger.info("Released startup initialization lock")

    # Start background jobs
    logger.info("Starting background jobs...")
    start_background_jobs(app)
    logger.info("✓ Background jobs started")

    logger.info("=" * 60)
    logger.info("Application startup completed successfully!")
    logger.info("=" * 60)

    # ==================== YIELD (app is running) ====================
    yield

    # ==================== SHUTDOWN ====================
    logger.info("Shutting down application...")

    # Close chat service HTTP client
    from app.services.chat.base import close_http_client

    await close_http_client()
    logger.info("✓ Chat service HTTP client closed")

    # Stop background jobs
    stop_background_jobs(app)
    logger.info("✓ Application shutdown completed")

    # Shutdown OpenTelemetry
    from shared.telemetry.config import get_otel_config
    from shared.telemetry.core import is_telemetry_enabled, shutdown_telemetry

    if get_otel_config().enabled and is_telemetry_enabled():
        shutdown_telemetry()
        logger.info("✓ OpenTelemetry shutdown completed")


def create_app():
    # Toggle API docs/OpenAPI via environment (settings.ENABLE_API_DOCS, default True)
    enable_docs = settings.ENABLE_API_DOCS
    openapi_url = f"{settings.API_PREFIX}/openapi.json" if enable_docs else None
    docs_url = f"{settings.API_PREFIX}/docs" if enable_docs else None
    redoc_url = f"{settings.API_PREFIX}/redoc" if enable_docs else None

    app = FastAPI(
        title=settings.PROJECT_NAME,
        description="Task Management Backend System API",
        version=settings.VERSION,
        openapi_url=openapi_url,
        docs_url=docs_url,
        redoc_url=redoc_url,
        lifespan=lifespan,
    )

    logger = _logger

    # Initialize OpenTelemetry if enabled (configuration from shared/telemetry/config.py)
    from shared.telemetry.config import get_otel_config

    otel_config = get_otel_config("wegent-backend")
    if otel_config.enabled:
        try:
            from shared.telemetry.core import init_telemetry

            init_telemetry(
                service_name=otel_config.service_name,
                enabled=otel_config.enabled,
                otlp_endpoint=otel_config.otlp_endpoint,
                sampler_ratio=otel_config.sampler_ratio,
                service_version=settings.VERSION,
                deployment_environment=settings.ENVIRONMENT,
                metrics_enabled=otel_config.metrics_enabled,
                capture_request_headers=otel_config.capture_request_headers,
                capture_request_body=otel_config.capture_request_body,
                capture_response_headers=otel_config.capture_response_headers,
                capture_response_body=otel_config.capture_response_body,
                max_body_size=otel_config.max_body_size,
            )
            logger.info("OpenTelemetry initialized successfully")

            # Apply instrumentation with SQLAlchemy support
            from shared.telemetry.instrumentation import (
                setup_opentelemetry_instrumentation,
            )

            setup_opentelemetry_instrumentation(
                app=app,
                logger=logger,
                enable_sqlalchemy=True,
                sqlalchemy_engine=engine,
            )
        except Exception as e:
            logger.warning(f"Failed to initialize OpenTelemetry: {e}")
    else:
        logger.debug("OpenTelemetry is disabled")

    @app.middleware("http")
    async def log_requests(request: Request, call_next):
        from starlette.responses import StreamingResponse

        # Skip logging for health check/probe requests (root path)
        if request.url.path == "/":
            return await call_next(request)

        # Generate a unique request ID
        request_id = str(uuid.uuid4())[
            :8
        ]  # Use first 8 characters of UUID as request ID
        request.state.request_id = request_id

        start_time = time.time()

        # Extract username from Authorization header
        from app.core.security import get_username_from_request

        username = get_username_from_request(request)

        client_ip = request.client.host if request.client else "Unknown"

        # Capture request body if OTEL is enabled and body capture is configured
        request_body = None
        if (
            otel_config.enabled
            and otel_config.capture_request_body
            and request.method in ("POST", "PUT", "PATCH")
        ):
            try:
                # Read the body
                body_bytes = await request.body()
                if body_bytes:
                    # Limit body size to avoid huge spans
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
            from shared.telemetry.context import set_request_context, set_user_context
            from shared.telemetry.core import is_telemetry_enabled

            if is_telemetry_enabled():
                set_request_context(request_id)
                if username:
                    set_user_context(user_name=username)

                # Add request body to current span
                if request_body:
                    current_span = trace.get_current_span()
                    if current_span and current_span.is_recording():
                        current_span.set_attribute("http.request.body", request_body)

        # Pre-request logging with request ID
        logger.info(
            f"request : {request.method} {request.url.path} {request.query_params} {request_id} {client_ip} [{username}]"
        )

        # Process request
        response = await call_next(request)
        process_time = (time.time() - start_time) * 1000

        # Capture response headers and body if OTEL is enabled
        if otel_config.enabled:
            from opentelemetry import trace
            from shared.telemetry.core import is_telemetry_enabled

            if is_telemetry_enabled():
                current_span = trace.get_current_span()
                if current_span and current_span.is_recording():
                    # Capture response headers
                    if otel_config.capture_response_headers:
                        for header_name, header_value in response.headers.items():
                            # Skip sensitive headers
                            if header_name.lower() in (
                                "authorization",
                                "cookie",
                                "set-cookie",
                            ):
                                header_value = "[REDACTED]"
                            current_span.set_attribute(
                                f"http.response.header.{header_name}", header_value
                            )

                    # Capture response body (only for non-streaming responses)
                    if otel_config.capture_response_body:
                        if not isinstance(response, StreamingResponse):
                            try:
                                # For regular responses, we need to read and reconstruct the body
                                response_body_chunks = []
                                async for chunk in response.body_iterator:
                                    response_body_chunks.append(chunk)

                                response_body = b"".join(response_body_chunks)

                                # Limit body size
                                max_body_size = otel_config.max_body_size
                                if response_body:
                                    if len(response_body) <= max_body_size:
                                        body_str = response_body.decode(
                                            "utf-8", errors="replace"
                                        )
                                    else:
                                        body_str = (
                                            response_body[:max_body_size].decode(
                                                "utf-8", errors="replace"
                                            )
                                            + f"... [truncated, total size: {len(response_body)} bytes]"
                                        )
                                    current_span.set_attribute(
                                        "http.response.body", body_str
                                    )

                                # Reconstruct the response with the body
                                from starlette.responses import Response

                                response = Response(
                                    content=response_body,
                                    status_code=response.status_code,
                                    headers=dict(response.headers),
                                    media_type=response.media_type,
                                )
                            except Exception as e:
                                logger.debug(f"Failed to capture response body: {e}")

        # Post-request logging with request ID
        logger.info(
            f"response: {request.method} {request.url.path} {request.query_params} {request_id} {client_ip} [{username}] {response.status_code} {process_time:.2f}ms"
        )

        # Add request ID to response headers for client-side tracking
        response.headers["X-Request-ID"] = request_id

        return response

    # Setup CORS
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # Register exception handlers
    app.add_exception_handler(CustomHTTPException, http_exception_handler)
    app.add_exception_handler(RequestValidationError, validation_exception_handler)
    app.add_exception_handler(Exception, python_exception_handler)

    # Include API routes
    app.include_router(api_router, prefix=settings.API_PREFIX)

    return app


app = create_app()


# Root path
@app.get("/")
async def root():
    """
    Root path, returns API information
    """
    return {
        "name": settings.PROJECT_NAME,
        "version": settings.VERSION,
        "api_prefix": settings.API_PREFIX,
        "docs_url": f"{settings.API_PREFIX}/docs",
    }
