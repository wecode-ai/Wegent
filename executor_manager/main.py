#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

"""
Main entry module, starts the task scheduling service and FastAPI server
Supports two startup modes:
1. Run directly: python main.py
2. Use uvicorn: uvicorn main:app --host 0.0.0.0 --port 8080
"""

import threading
import uvicorn
from contextlib import asynccontextmanager

# Import the shared logger
from shared.logger import setup_logger

from scheduler.scheduler import TaskScheduler
from routers.routers import app  # Import the FastAPI app defined in routes.py


# Setup logger
logger = setup_logger(__name__)

@asynccontextmanager
async def lifespan(app):
    """
    FastAPI application lifecycle manager
    Starts the task scheduler when the application starts, and performs cleanup operations when the application shuts down
    """
    # Start the task scheduler
    logger.info("Initializing task scheduler...")
    scheduler_instance = TaskScheduler()
    
    # Start the scheduler in a separate thread
    scheduler_thread = threading.Thread(target=start_scheduler, args=(scheduler_instance,))
    scheduler_thread.daemon = True
    scheduler_thread.start()
    
    logger.info("Task scheduler started successfully")
    
    yield  # During FastAPI application runtime
    
    # Cleanup operations when the application shuts down (if needed)
    logger.info("Shutting down task scheduler...")
    # If TaskScheduler has a stop method, you can call it here
    if scheduler_instance:
        scheduler_instance.stop()

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
        uvicorn.run(app, host="0.0.0.0", port=8080)
    except Exception as e:
        logger.error(f"Service startup failed: {e}")
        return 1
    return 0

if __name__ == "__main__":
    exit(main())