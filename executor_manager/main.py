#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

"""
Main entry module, starts the task scheduling service and FastAPI server
Supports two startup modes:
1. Run directly: python main.py
2. Use uvicorn: uvicorn main:app --host 0.0.0.0 --port 8001
"""

import threading
from contextlib import asynccontextmanager

import uvicorn
# Import the shared logger
from shared.logger import setup_logger
from shared.telemetry.config import get_otel_config

from executor_manager.services.sandbox import get_sandbox_manager
from routers.routers import app  # Import the FastAPI app defined in routes.py
from scheduler.scheduler import TaskScheduler

# Setup logger
logger = setup_logger(__name__)


@asynccontextmanager
async def lifespan(app):
    """
    FastAPI application lifecycle manager.
    Starts the task scheduler when the application starts, and performs cleanup operations when the application shuts down.
    """
    # Initialize OpenTelemetry if enabled (configuration from shared/telemetry/config.py)
    otel_config = get_otel_config("wegent-executor-manager")
    if otel_config.enabled:
        try:
            from shared.telemetry.core import init_telemetry

            init_telemetry(
                service_name=otel_config.service_name,
                enabled=otel_config.enabled,
                otlp_endpoint=otel_config.otlp_endpoint,
                sampler_ratio=otel_config.sampler_ratio,
                service_version="0.1.0",
                metrics_enabled=otel_config.metrics_enabled,
                capture_request_headers=otel_config.capture_request_headers,
                capture_request_body=otel_config.capture_request_body,
                capture_response_headers=otel_config.capture_response_headers,
                capture_response_body=otel_config.capture_response_body,
                max_body_size=otel_config.max_body_size,
            )
            logger.info("OpenTelemetry initialized successfully")

            # Apply instrumentation
            from shared.telemetry.instrumentation import \
                setup_opentelemetry_instrumentation

            setup_opentelemetry_instrumentation(app, logger)
        except Exception as e:
            logger.warning(f"Failed to initialize OpenTelemetry: {e}")
    # Extract executor binary to Named Volume on startup
    logger.info("Extracting executor binary to Named Volume...")
    try:
        from executors.docker.binary_extractor import extract_executor_binary

        if extract_executor_binary():
            logger.info("Executor binary extraction completed")
        else:
            logger.warning(
                "Executor binary extraction failed, custom base images may not work"
            )
    except Exception as e:
        logger.warning(
            f"Executor binary extraction error: {e}, custom base images may not work"
        )

    # Start the task scheduler
    logger.info("Initializing task scheduler...")
    scheduler_instance = TaskScheduler()

    # Start the scheduler in a separate thread
    scheduler_thread = threading.Thread(
        target=start_scheduler, args=(scheduler_instance,)
    )
    scheduler_thread.daemon = True
    scheduler_thread.start()

    logger.info("Task scheduler started successfully")

    # Start SandboxManager scheduler for GC
    sandbox_manager = get_sandbox_manager()
    try:
        await sandbox_manager.start_gc_task()
        logger.info("SandboxManager scheduler started successfully")
    except Exception as e:
        logger.warning(f"Failed to start SandboxManager scheduler: {e}")

    yield  # During FastAPI application runtime

    # Cleanup operations when the application shuts down (if needed)
    logger.info("Shutting down task scheduler...")
    # If TaskScheduler has a stop method, you can call it here
    if scheduler_instance:
        scheduler_instance.stop()

    # Stop SandboxManager garbage collection
    if sandbox_manager:
        logger.info("Stopping SandboxManager...")
        await sandbox_manager.stop_gc_task()

    # Shutdown OpenTelemetry
    if otel_config.enabled:
        from shared.telemetry.core import shutdown_telemetry

        shutdown_telemetry()
        logger.info("OpenTelemetry shutdown completed")


def start_scheduler(scheduler):
    """Start the task scheduler in a separate thread"""
    try:
        logger.info("Starting task scheduling service...")
        scheduler.start()
    except Exception as e:
        logger.error(f"Scheduler service startup failed: {e}")
        return 1
    return 0


# Set the FastAPI application's lifecycle manager
app.router.lifespan_context = lifespan


def main():
    """
    Main function, starts the FastAPI server
    Used when running the script directly
    """
    try:
        # Start the FastAPI server
        logger.info("Starting FastAPI server...")
        uvicorn.run(app, host="0.0.0.0", port=8001)
    except Exception as e:
        logger.error(f"Service startup failed: {e}")
        return 1
    return 0


if __name__ == "__main__":
    exit(main())
