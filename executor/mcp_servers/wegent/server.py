#!/usr/bin/env python
# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Wegent MCP Server - HTTP-based MCP server for Wegent internal tools.

This server provides internal tools for Wegent executors, including:
- silent_exit: Silently exit execution without notifying the user

The server uses Streamable HTTP transport which is the recommended approach
for HTTP-based MCP servers (SSE is deprecated).
"""

import asyncio
import contextlib
import json
import os
import threading
from typing import Optional

import requests
import uvicorn
from mcp.server.fastmcp import FastMCP
from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Mount, Route

from shared.logger import setup_logger

logger = setup_logger("wegent_mcp_server")

# Default port for wegent MCP server
DEFAULT_MCP_PORT = 20002

# Create FastMCP server instance with streamable HTTP path at root
mcp_server = FastMCP(
    "wegent-mcp-server",
    stateless_http=True,  # Stateless mode for simpler operation
    json_response=True,  # Return JSON responses
    streamable_http_path="/",  # Mount at root of the /mcp path
)


def _get_task_info() -> dict:
    """Get task info from TASK_INFO environment variable.

    Returns:
        dict: Task info containing task_id, subtask_id, etc.
    """
    task_info_str = os.getenv("TASK_INFO")
    if not task_info_str:
        return {}
    try:
        return json.loads(task_info_str)
    except json.JSONDecodeError:
        logger.error("Failed to parse TASK_INFO environment variable")
        return {}


def _send_silent_exit_callback(reason: str) -> bool:
    """Send callback to executor_manager to set task status to COMPLETED with silent_exit flag.

    The backend will detect the silent_exit flag in the result and set the
    BackgroundExecution status to COMPLETED_SILENT accordingly.

    Args:
        reason: Reason for silent exit

    Returns:
        bool: True if callback was sent successfully
    """
    task_info = _get_task_info()
    if not task_info:
        logger.warning("No TASK_INFO available, cannot send silent_exit callback")
        return False

    task_id = task_info.get("task_id")
    subtask_id = task_info.get("subtask_id")
    if not task_id or not subtask_id:
        logger.warning("Missing task_id or subtask_id in TASK_INFO")
        return False

    # Get callback URL from environment
    callback_url = os.getenv("CALLBACK_URL")
    if not callback_url:
        logger.warning("CALLBACK_URL not set, cannot send silent_exit callback")
        return False

    # Build callback payload
    # Use COMPLETED status with silent_exit flag in result
    # Backend's _update_background_execution_status() will detect silent_exit flag
    # and set BackgroundExecution status to COMPLETED_SILENT
    payload = {
        "task_id": task_id,
        "subtask_id": subtask_id,
        "task_title": task_info.get("task_title", ""),
        "subtask_title": task_info.get("subtask_title", ""),
        "executor_name": os.getenv("EXECUTOR_NAME"),
        "executor_namespace": os.getenv("EXECUTOR_NAMESPACE"),
        "progress": 100,
        "status": "COMPLETED",
        "error_message": reason,
        "result": {
            "value": reason or "Silent exit",
            "silent_exit": True,
            "silent_exit_reason": reason,
        },
        "task_type": task_info.get("type"),
    }

    try:
        logger.info(f"Sending silent_exit callback to {callback_url}")
        response = requests.post(callback_url, json=payload, timeout=10)
        if response.status_code in [200, 201, 204]:
            logger.info(f"Silent exit callback sent successfully: {response.text}")
            return True
        else:
            logger.error(
                f"Failed to send silent_exit callback: {response.status_code} {response.text}"
            )
            return False
    except Exception as e:
        logger.error(f"Error sending silent_exit callback: {e}")
        return False


@mcp_server.tool()
def silent_exit(reason: str = "") -> str:
    """Call this tool when the execution result does not require user attention.

    For example: regular status checks with no anomalies, routine data collection
    with expected results, or monitoring tasks where everything is normal.
    This will end the execution immediately and hide it from the timeline by default.

    Args:
        reason: Optional reason for silent exit (for logging only, not shown to user)

    Returns:
        JSON string with silent exit marker
    """
    logger.info(f"Silent exit called with reason: {reason}")

    # Send callback to set task status to COMPLETED_SILENT
    callback_sent = _send_silent_exit_callback(reason)
    if callback_sent:
        logger.info(
            "Silent exit callback sent, task will be marked as COMPLETED_SILENT"
        )
    else:
        logger.warning(
            "Failed to send silent_exit callback, falling back to marker-based detection"
        )

    # Return special marker that executor can detect (as fallback)
    return json.dumps({"__silent_exit__": True, "reason": reason})


def create_wegent_mcp_app() -> Starlette:
    """Create a Starlette application for the Wegent MCP server.

    Returns:
        Starlette application configured with Streamable HTTP transport for MCP.
    """

    async def health_check(request):
        """Health check endpoint."""
        return JSONResponse({"status": "healthy", "service": "wegent-mcp-server"})

    # Create a lifespan context manager to run the session manager
    @contextlib.asynccontextmanager
    async def lifespan(app: Starlette):
        async with mcp_server.session_manager.run():
            yield

    # Create Starlette app with routes
    # Mount the StreamableHTTP server at /mcp
    app = Starlette(
        debug=False,
        routes=[
            Route("/health", health_check, methods=["GET"]),
            Mount("/mcp", app=mcp_server.streamable_http_app()),
        ],
        lifespan=lifespan,
    )

    return app


# Global variable to track the server thread
_server_thread: Optional[threading.Thread] = None
_server_instance: Optional[uvicorn.Server] = None


def start_wegent_mcp_server(port: Optional[int] = None, background: bool = True) -> str:
    """Start the Wegent MCP server.

    Args:
        port: Port to run the server on. Defaults to DEFAULT_MCP_PORT or WEGENT_MCP_PORT env var.
        background: If True, run in a background thread. If False, run in foreground (blocking).

    Returns:
        The URL of the running MCP server (Streamable HTTP endpoint).
    """
    global _server_thread, _server_instance

    if port is None:
        port = int(os.getenv("WEGENT_MCP_PORT", str(DEFAULT_MCP_PORT)))

    app = create_wegent_mcp_app()
    config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning")
    server = uvicorn.Server(config)
    _server_instance = server

    # Streamable HTTP endpoint URL
    server_url = f"http://127.0.0.1:{port}/mcp"

    if background:
        # Run in background thread
        def run_server():
            asyncio.run(server.serve())

        _server_thread = threading.Thread(target=run_server, daemon=True)
        _server_thread.start()
        logger.info(
            f"Wegent MCP server started in background at {server_url} (Streamable HTTP)"
        )
    else:
        # Run in foreground (blocking)
        logger.info(f"Starting Wegent MCP server at {server_url} (Streamable HTTP)")
        asyncio.run(server.serve())

    return server_url


def stop_wegent_mcp_server():
    """Stop the Wegent MCP server if running."""
    global _server_instance

    if _server_instance is not None:
        _server_instance.should_exit = True
        logger.info("Wegent MCP server stopped")
        _server_instance = None


def get_wegent_mcp_url(port: Optional[int] = None) -> str:
    """Get the URL for the Wegent MCP server.

    Args:
        port: Port the server is running on. Defaults to DEFAULT_MCP_PORT or WEGENT_MCP_PORT env var.

    Returns:
        The Streamable HTTP endpoint URL for the MCP server.
    """
    if port is None:
        port = int(os.getenv("WEGENT_MCP_PORT", str(DEFAULT_MCP_PORT)))
    return f"http://127.0.0.1:{port}/mcp"


if __name__ == "__main__":
    # Run server in foreground when executed directly
    start_wegent_mcp_server(background=False)
