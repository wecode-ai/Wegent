# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from fastapi import FastAPI, Request
import time
import structlog
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
from app.db.session import engine
from app.db.base import Base

# Import all models to ensure they are registered with SQLAlchemy
from app.models import *  # noqa: F401,F403

def create_app():
    app = FastAPI(
        title=settings.PROJECT_NAME,
        description="Task Management Backend System API",
        version=settings.VERSION,
        openapi_url=f"{settings.API_PREFIX}/openapi.json",
        docs_url=f"{settings.API_PREFIX}/docs",
        redoc_url=f"{settings.API_PREFIX}/redoc",
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

    # Create database tables
    @app.on_event("startup")
    def startup():
        Base.metadata.create_all(bind=engine)

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