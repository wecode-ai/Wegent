# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from fastapi import FastAPI, Request
import time
import structlog
from fastapi.middleware.cors import CORSMiddleware
import threading

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
from app.services.subtask import subtask_service

# Import all models to ensure they are registered with SQLAlchemy
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
    logger = structlog.get_logger(__name__)

    @app.middleware("http")
    async def log_requests(request: Request, call_next):
        start_time = time.time()
        
        # Pre-request logging
        client_ip = request.client.host if request.client else "Unknown"
        logger.info(f"request : {request.method} {request.url.path} {request.query_params} {client_ip}")
        
        # Process request
        response = await call_next(request)
        process_time = (time.time() - start_time) * 1000
        
        # Post-request logging
        logger.info(f"response: {request.method} {request.url.path} {request.query_params} {client_ip} {response.status_code} {process_time:.2f}ms")
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

    # Background cleanup worker
    def _cleanup_worker(stop_event: threading.Event):
        # Periodically scan and cleanup stale executors for subtasks
        while not stop_event.is_set():
            try:
                db = SessionLocal()
                try:
                    subtask_service.cleanup_stale_executors(db)
                finally:
                    db.close()
            except Exception as e:
                # Log and continue loop
                logger.error(f"subtask cleanup worker error: {e}")
            # Wait with wake-up capability
            stop_event.wait(timeout=settings.SUBTASK_CLEANUP_INTERVAL_SECONDS)

    # Create database tables and start background worker
    @app.on_event("startup")
    def startup():
        Base.metadata.create_all(bind=engine)
        # Start cleanup thread
        app.state.cleanup_stop_event = threading.Event()
        app.state.cleanup_thread = threading.Thread(
            target=_cleanup_worker,
            args=(app.state.cleanup_stop_event,),
            name="subtask-cleanup-worker",
            daemon=True,
        )
        app.state.cleanup_thread.start()
        logger.info("subtask cleanup worker started")

    @app.on_event("shutdown")
    def shutdown():
        # Stop cleanup thread gracefully
        stop_event = getattr(app.state, "cleanup_stop_event", None)
        thread = getattr(app.state, "cleanup_thread", None)
        if stop_event:
            stop_event.set()
        if thread:
            thread.join(timeout=5.0)
        logger.info("subtask cleanup worker stopped")

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