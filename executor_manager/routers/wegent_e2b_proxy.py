# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Private protocol proxy router for executor_manager.

This module implements the private protocol for E2B SDK that uses path-based routing
instead of subdomain-based routing:

Original E2B format:  <port>-<sandboxID>.E2B_DOMAIN
Private protocol:     E2B_DOMAIN/executor-manager/e2b/proxy/<sandboxID>/<port>/<path>

This allows deployments without wildcard DNS and certificates.

For subagent tasks (metadata.task_type == "subagent"), requests are forwarded
to the existing executor task dispatch endpoint (/api/tasks/execute).
"""

import json
import os
import time

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from shared.logger import setup_logger

from executor_manager.common.config import ROUTE_PREFIX, get_config
from executor_manager.services.sandbox import get_sandbox_manager

logger = setup_logger(__name__)

router = APIRouter(tags=["sandbox-proxy"])


async def _find_sandbox_by_e2b_id(manager, e2b_sandbox_id: str):
    """Find sandbox by E2B sandbox ID in metadata.

    Searches through active sandboxes for one with matching e2b_sandbox_id
    in metadata.

    Args:
        manager: SandboxManager instance
        e2b_sandbox_id: E2B format sandbox UUID

    Returns:
        Sandbox if found, None otherwise
    """
    repository = manager._repository
    sandbox_ids = repository.get_active_sandbox_ids()

    for sandbox_id in sandbox_ids:
        sandbox = repository.load_sandbox(sandbox_id)
        if sandbox and sandbox.metadata.get("e2b_sandbox_id") == e2b_sandbox_id:
            return sandbox

    return None


async def _get_sandbox_info(sandbox_id: str) -> tuple:
    """Get sandbox info including base_url and metadata.

    Args:
        sandbox_id: E2B sandbox UUID

    Returns:
        Tuple of (base_url, sandbox) for the container
    """
    manager = get_sandbox_manager()

    # Find sandbox by e2b_sandbox_id
    sandbox = await _find_sandbox_by_e2b_id(manager, sandbox_id)
    if sandbox is None:
        # Fallback: try direct lookup
        sandbox = await manager.get_sandbox(sandbox_id, check_health=False)

    if sandbox is None:
        raise HTTPException(
            status_code=404,
            detail={"code": "not_found", "message": f"Sandbox {sandbox_id} not found"},
        )

    # Get container base_url from sandbox
    base_url = sandbox.base_url
    if not base_url:
        raise HTTPException(
            status_code=503,
            detail={
                "code": "unavailable",
                "message": f"Sandbox {sandbox_id} not available",
            },
        )

    return base_url, sandbox


@router.api_route(
    "/{sandbox_id}/{port:int}/{path:path}",
    methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"],
)
async def proxy_to_sandbox(sandbox_id: str, port: int, path: str, request: Request):
    """Proxy requests to sandbox container.

    This endpoint proxies HTTP requests to the sandbox container using path-based
    routing instead of subdomain-based routing.

    URL format: {ROUTE_PREFIX}/e2b/proxy/<sandboxID>/<port>/<path>

    For subagent tasks (metadata.task_type == "subagent"), requests to /execute
    are transformed and forwarded to the executor's task dispatch endpoint.

    Examples:
        {ROUTE_PREFIX}/e2b/proxy/abc123/49983/execute -> http://container_host:mapped_port/execute
        {ROUTE_PREFIX}/e2b/proxy/abc123/49999/contexts -> http://container_host:mapped_port/contexts

    Args:
        sandbox_id: E2B sandbox UUID
        port: Target port inside container (e.g., 49983 for envd, 49999 for code server)
        path: Path to forward to container
        request: Original HTTP request

    Returns:
        Proxied response from container
    """
    logger.info(
        f"[SandboxProxy] Proxy request received: sandbox_id={sandbox_id}, port={port}, path={path}"
    )

    try:
        # Get sandbox info including metadata
        base_url, sandbox = await _get_sandbox_info(sandbox_id)

        # Check if this is a subagent task
        task_type = sandbox.metadata.get("task_type")
        is_subagent = task_type == "subagent"

        logger.info(
            f"[SandboxProxy] Sandbox metadata: task_type={task_type}, is_subagent={is_subagent}"
        )

        # Read request body
        body = await request.body()

        # For subagent tasks, transform the request for executor's task dispatch endpoint
        if is_subagent and path == "execute" and request.method == "POST":
            return await _proxy_subagent_execute(base_url, sandbox, body, request)

        # Regular proxy for non-subagent tasks or non-execute paths
        target_url = f"{base_url}/{path}"

        # Get query string
        query_string = str(request.query_params)
        if query_string:
            target_url = f"{target_url}?{query_string}"

        logger.info(f"[SandboxProxy] Proxying {request.method} {path} -> {target_url}")

        # Forward headers (exclude hop-by-hop headers)
        excluded_headers = {
            "host",
            "connection",
            "keep-alive",
            "proxy-authenticate",
            "proxy-authorization",
            "te",
            "trailers",
            "transfer-encoding",
            "upgrade",
        }
        headers = {
            key: value
            for key, value in request.headers.items()
            if key.lower() not in excluded_headers
        }

        # Make request to container
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.request(
                method=request.method,
                url=target_url,
                headers=headers,
                content=body,
            )

        # Check if response is streaming
        content_type = response.headers.get("content-type", "")
        is_streaming = (
            "text/event-stream" in content_type
            or "application/x-ndjson" in content_type
            or response.headers.get("transfer-encoding") == "chunked"
        )

        if is_streaming:
            # For streaming responses, return StreamingResponse
            async def stream_response():
                async for chunk in response.aiter_bytes():
                    yield chunk

            return StreamingResponse(
                stream_response(),
                status_code=response.status_code,
                headers=dict(response.headers),
                media_type=content_type,
            )
        else:
            # For regular responses, return directly
            return StreamingResponse(
                iter([response.content]),
                status_code=response.status_code,
                headers=dict(response.headers),
                media_type=content_type or "application/json",
            )

    except HTTPException:
        raise
    except httpx.ConnectError as e:
        logger.error(f"[SandboxProxy] Connection failed to sandbox {sandbox_id}: {e}")
        raise HTTPException(
            status_code=503,
            detail={
                "code": "connection_failed",
                "message": f"Failed to connect to sandbox: {str(e)}",
            },
        )
    except httpx.TimeoutException as e:
        logger.error(f"[SandboxProxy] Timeout connecting to sandbox {sandbox_id}: {e}")
        raise HTTPException(
            status_code=504,
            detail={"code": "timeout", "message": f"Request timeout: {str(e)}"},
        )
    except Exception as e:
        logger.error(f"[SandboxProxy] Proxy error for sandbox {sandbox_id}: {e}")
        raise HTTPException(
            status_code=500,
            detail={"code": "proxy_error", "message": str(e)},
        )


async def _proxy_subagent_execute(
    base_url: str, sandbox, body: bytes, _request: Request
):
    """Proxy execute request for subagent tasks with polling mode.

    For subagent tasks, instead of waiting for execution to complete,
    we immediately return a task_url for the client to query results.
    This maintains service decoupling and allows independent deployment.

    E2B SDK run_code() sends:
    {
        "code": "<JSON string or plain text>",
        "context_id": "...",
        "language": "python",
        "env_vars": {...}
    }

    For subagent tasks, the "code" field should be a JSON string containing:
    {
        "task_prompt": "任务描述",
        "subtask_id": 456,
        "workspace_ref": "workspace-123",
        "timeout": 600,
        "bot_config": {...}
    }

    Args:
        base_url: Container base URL (e.g., http://localhost:8080)
        sandbox: Sandbox object with metadata
        body: Original request body (E2B execute format)
        request: Original HTTP request

    Returns:
        StreamingResponse with E2B standard NDJSON format containing task_url
    """
    try:
        # Parse E2B execute request
        e2b_request = json.loads(body) if body else {}
        logger.info(f"[SandboxProxy] SubAgent execute request: {e2b_request}")

        # Get the "code" field which should be a JSON string for subagent tasks
        code_field = e2b_request.get("code", "")

        # Try to parse "code" as JSON to extract subagent parameters
        try:
            subagent_params = json.loads(code_field)
            task_prompt = subagent_params.get("task_prompt", code_field)
            subtask_id = subagent_params.get("subtask_id")
            workspace_ref = subagent_params.get("workspace_ref")
            timeout = subagent_params.get("timeout", 600)
            bot_config = subagent_params.get("bot_config")
        except (json.JSONDecodeError, TypeError):
            # If "code" is not JSON, treat it as plain task_prompt
            task_prompt = code_field
            subtask_id = None
            workspace_ref = None
            timeout = 600
            bot_config = None

        # Auto-generate subtask_id if not provided
        if subtask_id is None:
            subtask_id = int(time.time() * 1000)
            logger.info(f"[SandboxProxy] Auto-generated subtask_id: {subtask_id}")

        # Get sandbox identifiers - use task_id for internal operations
        task_id = sandbox.metadata.get("task_id")
        sandbox_id = str(task_id) if task_id else str(sandbox.sandbox_id)
        e2b_sandbox_id = sandbox.metadata.get("e2b_sandbox_id", sandbox_id)

        logger.info(
            f"[SandboxProxy] Creating execution: sandbox_id={sandbox_id}, "
            f"subtask_id={subtask_id}, task_id={task_id}"
        )

        # Create execution record (this also starts the execution in background)
        manager = get_sandbox_manager()
        logger.info(
            f"[SandboxProxy] Calling create_execution with sandbox_id={sandbox_id}, "
            f"subtask_id={subtask_id}, timeout={timeout}"
        )
        execution, error = await manager.create_execution(
            sandbox_id=sandbox_id,
            prompt=task_prompt,
            timeout=timeout,
            metadata={
                "subtask_id": subtask_id,
                "workspace_ref": workspace_ref,
                "bot_config": bot_config,
                "task_type": "subagent",
            },
        )
        logger.info(
            f"[SandboxProxy] create_execution result: execution={execution}, error={error}"
        )

        if error:
            logger.error(f"[SandboxProxy] Failed to create execution: {error}")
            return _error_response("execution_create_failed", error)

        # Build task_url for client to query results
        # Get base URL from environment variable for flexibility
        external_url = os.getenv(
            "EXECUTOR_MANAGER_EXTERNAL_URL", "http://localhost:8001"
        )

        task_url = f"{external_url}{ROUTE_PREFIX}/sandboxes/{sandbox_id}/executions/{subtask_id}"

        # E2B NDJSON format response
        result_payload = {
            "task_url": task_url,
            "sandbox_id": sandbox_id,
            "e2b_sandbox_id": e2b_sandbox_id,
            "task_id": task_id,
            "subtask_id": subtask_id,
            "execution_id": execution.execution_id,
            "status": "pending",
            "message": "Task submitted. Poll the task_url for results.",
        }

        logger.info(f"[SandboxProxy] Execution created, returning task_url: {task_url}")

        async def generate_response():
            yield json.dumps(
                {
                    "type": "result",
                    "text": json.dumps(result_payload),
                    "is_main_result": True,
                }
            ) + "\n"
            yield json.dumps({"type": "end_of_execution"}) + "\n"

        return StreamingResponse(
            generate_response(),
            media_type="application/x-ndjson",
        )

    except json.JSONDecodeError as e:
        logger.error(f"[SandboxProxy] Failed to parse execute request: {e}")
        return _error_response("invalid_request", f"Invalid JSON: {str(e)}")
    except Exception as e:
        logger.error(f"[SandboxProxy] SubAgent proxy error: {e}")
        return _error_response("proxy_error", str(e))


def _error_response(code: str, message: str):
    """Generate E2B standard error response in NDJSON format."""

    async def generate():
        yield json.dumps(
            {"type": "error", "name": code, "value": message, "traceback": ""}
        ) + "\n"
        yield json.dumps({"type": "end_of_execution"}) + "\n"

    return StreamingResponse(generate(), media_type="application/x-ndjson")
