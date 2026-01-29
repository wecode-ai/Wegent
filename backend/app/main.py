# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# Redis instrumentation must be set up BEFORE importing redis module
from shared.telemetry.config import get_otel_config as _get_otel_config_early

if _get_otel_config_early("wegent-backend").enabled:
    try:
        from opentelemetry.instrumentation.redis import RedisInstrumentor

        RedisInstrumentor().instrument()
    except Exception:
        pass

import asyncio
import logging
import signal
import sys
import time
import uuid
from contextlib import asynccontextmanager

import redis
import socketio
from fastapi import FastAPI, Request, Response
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
from app.core.shutdown import shutdown_manager
from app.core.yaml_init import run_yaml_initialization
from app.db.base import Base
from app.db.session import SessionLocal, engine
from app.models import *  # noqa: F401,F403
from app.services.jobs import start_background_jobs, stop_background_jobs

# Redis lock key for startup operations (migrations + YAML init)
# Only used to prevent concurrent initialization, not to skip initialization
STARTUP_LOCK_KEY = "wegent:startup_lock"
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

    # Try to get Redis client for distributed locking
    redis_client = None
    try:
        redis_client = redis.from_url(settings.REDIS_URL)
    except Exception as e:
        logger.warning(f"Failed to connect to Redis for startup lock: {e}")

    # Try to acquire lock for startup initialization (migrations + YAML)
    # The lock only prevents concurrent initialization, not repeated initialization
    # YAML initialization is idempotent (checks if resources exist before creating)
    acquired_lock = False
    if redis_client:
        acquired_lock = redis_client.set(
            STARTUP_LOCK_KEY, "locked", nx=True, ex=STARTUP_LOCK_TIMEOUT
        )
        if acquired_lock:
            logger.info("Acquired startup initialization lock")
        else:
            # Another worker is running startup initialization, skip and continue
            logger.info("Another worker is running startup initialization, skipping...")

    # Run startup initialization only if we acquired the distributed lock
    # Redis is required for distributed locking - fail fast if unavailable
    if not redis_client:
        logger.error(
            "Redis client is not available. Distributed locking is required for startup initialization. "
            "Please ensure Redis is running and accessible."
        )
        raise RuntimeError(
            "Redis is required for distributed locking during startup initialization"
        )

    if acquired_lock:
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
                    logger.error(f"✗ Unexpected error running Alembic migrations: {e}")
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
            # This is idempotent - existing resources are skipped
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

        except Exception as e:
            logger.error(f"✗ Startup initialization failed: {e}")
        finally:
            # Release lock
            redis_client.delete(STARTUP_LOCK_KEY)
            logger.info("Released startup initialization lock")

    # Start background jobs
    logger.info("Starting background jobs...")
    start_background_jobs(app)
    logger.info("✓ Background jobs started")

    # Start scheduler backend (for Flow scheduling)
    # The scheduler backend is selected based on SCHEDULER_BACKEND config:
    # - "celery" (default): Uses Celery Beat with embedded/standalone mode
    # - "apscheduler": Uses APScheduler (lightweight, no Redis required)
    # - "xxljob": Uses XXL-JOB distributed scheduler
    logger.info(f"Starting scheduler backend: {settings.SCHEDULER_BACKEND}...")
    from app.core.scheduler import start_scheduler

    scheduler = start_scheduler()
    if scheduler:
        logger.info(f"✓ Scheduler backend '{scheduler.backend_type}' started")
    else:
        logger.warning(
            "Failed to start scheduler backend. Flow scheduling may not work."
        )

    # Initialize Socket.IO WebSocket emitter
    # Note: Chat namespace is already registered in create_socketio_asgi_app()
    logger.info("Initializing Socket.IO...")
    from app.core.socketio import get_sio
    from app.services.chat.ws_emitter import init_ws_emitter

    sio = get_sio()
    init_ws_emitter(sio)
    logger.info("✓ Socket.IO initialized")

    # Initialize event bus and register event handlers
    # This enables decoupled communication between modules (e.g., pet experience updates)
    logger.info("Initializing event bus and registering handlers...")
    from app.core.events import init_event_bus
    from app.services.pet.event_handlers import register_pet_event_handlers

    init_event_bus()
    register_pet_event_handlers()
    logger.info("✓ Event bus initialized and handlers registered")

    # Initialize PendingRequestRegistry for skill frontend interactions
    # This starts the Redis Pub/Sub listener for cross-worker communication
    logger.info("Initializing PendingRequestRegistry...")
    from chat_shell.tools import (
        get_pending_request_registry,
    )

    await get_pending_request_registry()
    logger.info("✓ PendingRequestRegistry initialized")

    # Start device heartbeat monitor for local device support
    logger.info("Starting device heartbeat monitor...")
    from app.services.device_monitor import start_device_monitor

    start_device_monitor()
    logger.info("✓ Device heartbeat monitor started")

    # Initialize IM Channel Manager and start enabled channels
    # This enables DingTalk, Feishu, WeChat bot integrations
    logger.info("Initializing IM Channel Manager...")
    from app.services.channels import get_channel_manager

    channel_manager = get_channel_manager()
    db = SessionLocal()
    try:
        started_count = await channel_manager.start_all_enabled(db)
        logger.info(
            f"✓ IM Channel Manager initialized, {started_count} channels started"
        )
    except Exception as e:
        logger.warning(f"Failed to start IM channels: {e}")
    finally:
        db.close()

    logger.info("=" * 60)
    logger.info("Application startup completed successfully!")
    logger.info("=" * 60)

    # ==================== YIELD (app is running) ====================
    yield

    # ==================== SHUTDOWN ====================
    logger.info("=" * 60)
    logger.info("Graceful shutdown initiated...")
    logger.info("=" * 60)

    # Step 1: Initiate graceful shutdown (mark as shutting down)
    await shutdown_manager.initiate_shutdown()
    logger.info(
        "✓ Shutdown state set. Active streams: %d",
        shutdown_manager.get_active_stream_count(),
    )

    # Step 2: Wait for active streaming requests to complete
    shutdown_timeout = settings.GRACEFUL_SHUTDOWN_TIMEOUT
    if shutdown_manager.get_active_stream_count() > 0:
        logger.info(
            "Waiting for %d active streams to complete (timeout: %ds)...",
            shutdown_manager.get_active_stream_count(),
            shutdown_timeout,
        )
        streams_completed = await shutdown_manager.wait_for_streams(
            timeout=shutdown_timeout
        )

        if not streams_completed:
            # Timeout reached, cancel remaining streams
            remaining = shutdown_manager.get_active_stream_count()
            logger.warning(
                "Timeout reached. Cancelling %d remaining streams...", remaining
            )
            cancelled = await shutdown_manager.cancel_all_streams()
            logger.info("Cancelled %d streams", cancelled)

            # Give a short grace period for cancellation to propagate
            await asyncio.sleep(1)
    else:
        logger.info("No active streams, proceeding with shutdown")

    # Step 3: Stop IM Channel Manager
    from app.services.channels import get_channel_manager

    channel_manager = get_channel_manager()
    stopped_count = await channel_manager.stop_all()
    logger.info(f"✓ IM Channel Manager stopped, {stopped_count} channels stopped")

    # Step 4: Stop background jobs
    stop_background_jobs(app)
    logger.info("✓ Background jobs stopped")

    # Step 5: Stop scheduler backend
    from app.core.scheduler import get_active_scheduler, stop_scheduler

    scheduler = get_active_scheduler()
    if scheduler:
        stop_scheduler()
        logger.info(f"✓ Scheduler backend '{scheduler.backend_type}' stopped")

    # Step 6: Shutdown PendingRequestRegistry
    from chat_shell.tools import (
        shutdown_pending_request_registry,
    )

    await shutdown_pending_request_registry()
    logger.info("✓ PendingRequestRegistry shutdown completed")

    # Step 7: Stop device heartbeat monitor
    from app.services.device_monitor import stop_device_monitor_async

    await stop_device_monitor_async()
    logger.info("✓ Device heartbeat monitor stopped")

    # Step 7: Shutdown OpenTelemetry
    from shared.telemetry.config import get_otel_config
    from shared.telemetry.core import is_telemetry_enabled, shutdown_telemetry

    if get_otel_config().enabled and is_telemetry_enabled():
        shutdown_telemetry()
        logger.info("✓ OpenTelemetry shutdown completed")

    logger.info("=" * 60)
    logger.info(
        "Application shutdown completed. Duration: %.2fs",
        shutdown_manager.shutdown_duration,
    )
    logger.info("=" * 60)


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

        # Always set request context for logging (works even without OTEL)
        from shared.telemetry.context import (
            set_request_context,
            set_task_context,
            set_user_context,
        )

        set_request_context(request_id)
        if username:
            set_user_context(user_name=username)

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

            from shared.telemetry.core import is_telemetry_enabled

            if is_telemetry_enabled():
                # Extract task_id and subtask_id from request body for tracing
                if request_body:
                    try:
                        import json

                        body_json = json.loads(request_body)
                        task_id = body_json.get("task_id")
                        subtask_id = body_json.get("subtask_id")
                        if task_id is not None or subtask_id is not None:
                            set_task_context(task_id=task_id, subtask_id=subtask_id)
                        # Extract user_id from request body if available
                        user_id = body_json.get("user_id")
                        if user_id is not None:
                            set_user_context(user_id=str(user_id))
                    except (json.JSONDecodeError, TypeError):
                        pass  # Not JSON or invalid format, skip task context extraction

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

    # Register rate limiter exception handler and state
    from app.core.rate_limit import get_limiter, is_rate_limit_enabled

    if is_rate_limit_enabled():
        from slowapi import _rate_limit_exceeded_handler
        from slowapi.errors import RateLimitExceeded

        limiter = get_limiter()
        app.state.limiter = limiter
        app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
        logger.info("Rate limiting enabled for API endpoints")

    # Include API routes
    app.include_router(api_router, prefix=settings.API_PREFIX)

    return app


# Create FastAPI app
_fastapi_app = create_app()


def create_socketio_asgi_app():
    """
    Create combined ASGI app with Socket.IO mounted.

    Returns a combined app that routes Socket.IO traffic to Socket.IO server
    and everything else to FastAPI.
    """
    from app.api.ws import register_chat_namespace
    from app.api.ws.device_namespace import register_device_namespace
    from app.core.socketio import create_socketio_app, get_sio

    sio = get_sio()

    # Register chat namespace before creating ASGI app
    # This ensures the namespace is available when clients connect
    register_chat_namespace(sio)
    _logger.info("Chat namespace registered during ASGI app creation")

    # Register device namespace for local device connections
    register_device_namespace(sio)
    _logger.info("Device namespace registered during ASGI app creation")

    socketio_app = create_socketio_app(sio)

    # Create combined ASGI app
    return socketio.ASGIApp(
        sio,
        other_asgi_app=_fastapi_app,
        socketio_path="/socket.io",
    )


# Combined ASGI app (Socket.IO + FastAPI)
app = create_socketio_asgi_app()


# Root path (registered on FastAPI app)
@_fastapi_app.get("/")
async def root():
    """
    Root path, returns API information
    """
    return {
        "name": settings.PROJECT_NAME,
        "version": settings.VERSION,
        "api_prefix": settings.API_PREFIX,
        "docs_url": f"{settings.API_PREFIX}/docs",
        "socketio_path": "/socket.io",
    }
