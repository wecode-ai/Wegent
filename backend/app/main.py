# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import logging
import sys
import time
import uuid

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
    )

    # Initialize logging
    setup_logging()
    logger = logging.getLogger(__name__)

    @app.middleware("http")
    async def log_requests(request: Request, call_next):
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

        # Pre-request logging with request ID
        logger.info(
            f"request : {request.method} {request.url.path} {request.query_params} {request_id} {client_ip} [{username}]"
        )

        # Process request
        response = await call_next(request)
        process_time = (time.time() - start_time) * 1000

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

    # Create database tables and start background worker
    @app.on_event("startup")
    async def startup():
        # Initialize chat service HTTP client
        from app.services.chat.base import get_http_client

        await get_http_client()
        logger.info("✓ Chat service HTTP client initialized")

        # Run database migrations
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
        # Initialize database with YAML configuration
        logger.info("Starting YAML data initialization...")
        db = SessionLocal()
        try:
            run_yaml_initialization(db)
            logger.info("✓ YAML data initialization completed")
        except Exception as e:
            logger.error(f"✗ Failed to initialize database from YAML: {e}")
        finally:
            db.close()

        # Start background jobs
        logger.info("Starting background jobs...")
        start_background_jobs(app)
        logger.info("✓ Background jobs started")

        logger.info("=" * 60)
        logger.info("Application startup completed successfully!")
        logger.info("=" * 60)

    @app.on_event("shutdown")
    async def shutdown():
        logger.info("Shutting down application...")

        # Close chat service HTTP client
        from app.services.chat.base import close_http_client

        await close_http_client()
        logger.info("✓ Chat service HTTP client closed")

        # Stop background jobs
        stop_background_jobs(app)
        logger.info("✓ Application shutdown completed")

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
