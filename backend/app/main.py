# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from fastapi import FastAPI, Request
import time
import logging
import uuid
from fastapi.middleware.cors import CORSMiddleware

from app.api.api import api_router
from app.core.config import settings
from app.core.exceptions import (
    http_exception_handler,
    validation_exception_handler,
    python_exception_handler,
    CustomHTTPException,
    RequestValidationError
)
from app.core.logging import setup_logging
from app.db.session import engine, SessionLocal
from app.db.base import Base
from app.services.jobs import start_background_jobs, stop_background_jobs
from app.core.yaml_init import run_yaml_initialization
from app.models import *  # noqa: F401,F403

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
        request_id = str(uuid.uuid4())[:8]  # Use first 8 characters of UUID as request ID
        request.state.request_id = request_id
        
        start_time = time.time()
        
        # Extract username from Authorization header
        from app.core.security import get_username_from_request
        username = get_username_from_request(request)
        
        client_ip = request.client.host if request.client else "Unknown"
        
        # Pre-request logging with request ID
        logger.info(f"request : {request.method} {request.url.path} {request.query_params} {request_id} {client_ip} [{username}]")
        
        # Process request
        response = await call_next(request)
        process_time = (time.time() - start_time) * 1000
        
        # Post-request logging with request ID
        logger.info(f"response: {request.method} {request.url.path} {request.query_params} {request_id} {client_ip} [{username}] {response.status_code} {process_time:.2f}ms")
        
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
    def startup():
        # Auto-create database tables if enabled
        if settings.DB_AUTO_CREATE_TABLES:
            logger.info("Auto-creating database tables...")
            try:
                Base.metadata.create_all(bind=engine, checkfirst=True)
            except Exception as e:
                # Log the error but don't fail startup if tables already exist
                if "already exists" in str(e).lower():
                    logger.warning(f"Some tables already exist, continuing: {e}")
                else:
                    logger.error(f"Error creating database tables: {e}")
                    raise
        else:
            logger.info("Database auto-create tables is disabled")

        # Initialize database with YAML configuration
        db = SessionLocal()
        try:
            run_yaml_initialization(db)
        except Exception as e:
            logger.error(f"Failed to initialize database from YAML: {e}")
        finally:
            db.close()

        # Start background jobs
        start_background_jobs(app)

    @app.on_event("shutdown")
    def shutdown():
        # Stop background jobs
        stop_background_jobs(app)

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