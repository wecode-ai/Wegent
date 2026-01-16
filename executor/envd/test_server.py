#!/usr/bin/env python
# -*- coding: utf-8 -*-

"""
Simple test script to verify envd services
"""

import asyncio
import sys
import os

# Add parent directory to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from executor.envd.server import start_envd_server, stop_envd_server
from shared.logger import setup_logger

logger = setup_logger("envd_test")


async def test_server():
    """Test the envd server startup and shutdown"""
    logger.info("Starting envd server test...")

    try:
        # Start server
        logger.info("Starting server...")
        server = await start_envd_server(host="127.0.0.1", port=50051)
        logger.info("Server started successfully!")

        # Wait a bit
        logger.info("Server is running... (waiting 5 seconds)")
        await asyncio.sleep(5)

        # Stop server
        logger.info("Stopping server...")
        await stop_envd_server()
        logger.info("Server stopped successfully!")

        logger.info("Test completed successfully!")
        return True

    except Exception as e:
        logger.exception(f"Test failed: {e}")
        return False


if __name__ == "__main__":
    success = asyncio.run(test_server())
    sys.exit(0 if success else 1)
