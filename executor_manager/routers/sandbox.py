# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""E2B-like Sandbox REST API routes.

This module implements the Sandbox API following the E2B protocol pattern:
- POST   /sandboxes                     - Create a new sandbox
- GET    /sandboxes/{sandbox_id}        - Get sandbox status
- DELETE /sandboxes/{sandbox_id}        - Terminate sandbox
- POST   /sandboxes/{sandbox_id}/keep-alive - Extend sandbox timeout

Execution API:
- POST   /sandboxes/{sandbox_id}/execute        - Start execution
- GET    /sandboxes/{sandbox_id}/executions/{exec_id} - Get execution status
- GET    /sandboxes/{sandbox_id}/executions     - List executions

Note: sandbox_id is derived from task_id internally (sandbox_id = str(task_id))
"""

from typing import Optional

from fastapi import APIRouter, HTTPException, Query, Request
from shared.logger import setup_logger

from executor_manager.models.sandbox import SandboxStatus
from executor_manager.schemas.sandbox import (CreateSandboxRequest,
                                              CreateSandboxResponse,
                                              ExecuteRequest, ExecuteResponse,
                                              ExecutionStatusResponse,
                                              KeepAliveRequest,
                                              KeepAliveResponse,
                                              ListExecutionsResponse,
                                              SandboxStatusResponse,
                                              TerminateSandboxResponse)
from executor_manager.services.sandbox import get_sandbox_manager

logger = setup_logger(__name__)

# Create router with prefix
router = APIRouter(prefix="/sandboxes", tags=["sandboxes"])

# Note: WebSocket router is registered separately in routers.py
# to ensure correct route matching order (before dynamic {sandbox_id} routes)


# =============================================================================
# Sandbox Lifecycle Endpoints
# =============================================================================


@router.post("", response_model=CreateSandboxResponse)
async def create_sandbox(request: CreateSandboxRequest, http_request: Request):
    """Create a new sandbox.

    Creates an isolated execution environment (Docker container) that can
    run multiple executions. The sandbox will automatically terminate
    after the specified timeout unless kept alive.

    Args:
        request: Sandbox creation parameters
        http_request: HTTP request object

    Returns:
        CreateSandboxResponse with sandbox details
    """
    client_ip = http_request.client.host if http_request.client else "unknown"
    logger.info(
        f"[SandboxAPI] Create sandbox: shell_type={request.shell_type}, "
        f"user={request.user_name}, timeout={request.timeout}s from {client_ip}"
    )

    # Handle empty user_name
    user_name = request.user_name if request.user_name else "unknown"

    manager = get_sandbox_manager()
    sandbox, error = await manager.create_sandbox(
        shell_type=request.shell_type,
        user_id=request.user_id,
        user_name=user_name,
        timeout=request.timeout,
        workspace_ref=request.workspace_ref,
        bot_config=request.bot_config,
        metadata=request.metadata,
    )

    if sandbox is None:
        raise HTTPException(status_code=500, detail=error)

    if error:
        # Sandbox created but failed to start
        return CreateSandboxResponse(
            sandbox_id=sandbox.sandbox_id,
            status=sandbox.status.value,
            container_name=sandbox.container_name,
            shell_type=sandbox.shell_type,
            created_at=sandbox.created_at,
            expires_at=sandbox.expires_at,
            message=f"Sandbox creation failed: {error}",
        )

    logger.info(
        f"[SandboxAPI] Sandbox created: {sandbox.sandbox_id}, "
        f"container={sandbox.container_name}, base_url={sandbox.base_url}"
    )

    return CreateSandboxResponse(
        sandbox_id=sandbox.sandbox_id,
        status=sandbox.status.value,
        container_name=sandbox.container_name,
        shell_type=sandbox.shell_type,
        created_at=sandbox.created_at,
        expires_at=sandbox.expires_at,
        message="Sandbox created successfully",
    )


@router.get("/{sandbox_id}", response_model=SandboxStatusResponse)
async def get_sandbox(sandbox_id: str, http_request: Request):
    """Get sandbox status.

    Retrieves the current status and details of a sandbox.

    Args:
        sandbox_id: Unique sandbox identifier (internally uses task_id)
        http_request: HTTP request object

    Returns:
        SandboxStatusResponse with sandbox details
    """
    client_ip = http_request.client.host if http_request.client else "unknown"
    logger.debug(f"[SandboxAPI] Get sandbox: {sandbox_id} from {client_ip}")

    manager = get_sandbox_manager()
    sandbox = await manager.get_sandbox(sandbox_id)

    if sandbox is None:
        raise HTTPException(
            status_code=404,
            detail=f"Sandbox {sandbox_id} not found",
        )

    return SandboxStatusResponse(
        sandbox_id=sandbox.sandbox_id,
        status=sandbox.status.value,
        container_name=sandbox.container_name,
        shell_type=sandbox.shell_type,
        base_url=sandbox.base_url,
        user_id=sandbox.user_id,
        user_name=sandbox.user_name,
        created_at=sandbox.created_at,
        started_at=sandbox.started_at,
        last_activity_at=sandbox.last_activity_at,
        expires_at=sandbox.expires_at,
        uptime=sandbox.uptime,
        time_remaining=sandbox.time_remaining,
        execution_count=len(sandbox.executions),
        error_message=sandbox.error_message,
        metadata=sandbox.metadata,
    )


@router.delete("/{sandbox_id}", response_model=TerminateSandboxResponse)
async def terminate_sandbox(sandbox_id: str, http_request: Request):
    """Terminate a sandbox.

    Stops and removes the sandbox container. Any running executions
    will be cancelled.

    Args:
        sandbox_id: Unique sandbox identifier (internally uses task_id)
        http_request: HTTP request object

    Returns:
        TerminateSandboxResponse with termination status
    """
    client_ip = http_request.client.host if http_request.client else "unknown"
    logger.info(f"[SandboxAPI] Terminate sandbox: {sandbox_id} from {client_ip}")

    manager = get_sandbox_manager()
    success, message = await manager.terminate_sandbox(sandbox_id)

    if not success:
        raise HTTPException(
            status_code=404,
            detail=message,
        )

    return TerminateSandboxResponse(
        sandbox_id=sandbox_id,
        status="terminated",
        message=message,
    )


@router.post("/{sandbox_id}/keep-alive", response_model=KeepAliveResponse)
async def keep_alive(
    sandbox_id: str,
    request: KeepAliveRequest,
    http_request: Request,
):
    """Extend sandbox timeout.

    Adds additional time to the sandbox expiration. The sandbox will
    automatically terminate after the new timeout unless kept alive again.

    Args:
        sandbox_id: Unique sandbox identifier (internally uses task_id)
        request: Keep-alive parameters
        http_request: HTTP request object

    Returns:
        KeepAliveResponse with new expiration time
    """
    client_ip = http_request.client.host if http_request.client else "unknown"
    logger.debug(
        f"[SandboxAPI] Keep-alive sandbox: {sandbox_id}, "
        f"timeout={request.timeout}s from {client_ip}"
    )

    manager = get_sandbox_manager()
    sandbox, error = await manager.keep_alive(sandbox_id, request.timeout)

    if sandbox is None:
        raise HTTPException(
            status_code=404,
            detail=error,
        )

    return KeepAliveResponse(
        sandbox_id=sandbox.sandbox_id,
        expires_at=sandbox.expires_at,
        time_remaining=sandbox.time_remaining,
        message=f"Sandbox timeout extended by {request.timeout} seconds",
    )


# =============================================================================
# Execution Endpoints
# =============================================================================


@router.post("/{sandbox_id}/execute", response_model=ExecuteResponse)
async def execute(
    sandbox_id: str,
    request: ExecuteRequest,
    http_request: Request,
):
    """Start an execution in a sandbox.

    Submits a task prompt to be executed in the sandbox container.
    The execution runs asynchronously - use the status endpoint to
    check for completion.

    Args:
        sandbox_id: Unique sandbox identifier (internally uses task_id)
        request: Execution parameters
        http_request: HTTP request object

    Returns:
        ExecuteResponse with execution details
    """
    client_ip = http_request.client.host if http_request.client else "unknown"
    logger.info(
        f"[SandboxAPI] Execute in sandbox: {sandbox_id}, "
        f"prompt_length={len(request.prompt)}, timeout={request.timeout}s "
        f"from {client_ip}"
    )

    manager = get_sandbox_manager()
    execution, error = await manager.create_execution(
        sandbox_id=sandbox_id,
        prompt=request.prompt,
        timeout=request.timeout,
        metadata=request.metadata,
    )

    if execution is None:
        raise HTTPException(
            status_code=404,
            detail=error,
        )

    # Truncate prompt for response
    prompt_preview = (
        request.prompt[:200] + "..." if len(request.prompt) > 200 else request.prompt
    )

    return ExecuteResponse(
        execution_id=execution.execution_id,
        sandbox_id=execution.sandbox_id,
        status=execution.status.value,
        prompt=prompt_preview,
        created_at=execution.created_at,
        message="Execution started",
    )


@router.get(
    "/{sandbox_id}/executions/{subtask_id}",
    response_model=ExecutionStatusResponse,
)
async def get_execution_status(
    sandbox_id: str,
    subtask_id: int,
    http_request: Request,
):
    """Get execution status by subtask ID.

    Retrieves the current status and result of an execution.

    Args:
        sandbox_id: Unique sandbox identifier (internally uses task_id)
        subtask_id: Subtask ID
        http_request: HTTP request object

    Returns:
        ExecutionStatusResponse with execution details
    """
    client_ip = http_request.client.host if http_request.client else "unknown"
    logger.info(
        f"[SandboxAPI] Get execution: subtask_id={subtask_id} in sandbox {sandbox_id} "
        f"from {client_ip}"
    )

    manager = get_sandbox_manager()
    execution = await manager.get_execution(sandbox_id, subtask_id)

    if execution is None:
        raise HTTPException(
            status_code=404,
            detail=f"Execution for subtask {subtask_id} not found in sandbox {sandbox_id}",
        )

    # Truncate prompt for response
    prompt_preview = (
        execution.prompt[:200] + "..."
        if len(execution.prompt) > 200
        else execution.prompt
    )

    return ExecutionStatusResponse(
        execution_id=execution.execution_id,
        sandbox_id=execution.sandbox_id,
        status=execution.status.value,
        prompt=prompt_preview,
        result=execution.result,
        error_message=execution.error_message,
        progress=execution.progress,
        created_at=execution.created_at,
        started_at=execution.started_at,
        completed_at=execution.completed_at,
        execution_time=execution.execution_time,
        metadata=execution.metadata,
    )


@router.get(
    "/{sandbox_id}/executions",
    response_model=ListExecutionsResponse,
)
async def list_executions(sandbox_id: str, http_request: Request):
    """List all executions in a sandbox.

    Retrieves all executions that have been submitted to a sandbox.

    Args:
        sandbox_id: Unique sandbox identifier
        http_request: HTTP request object

    Returns:
        ListExecutionsResponse with execution list
    """
    client_ip = http_request.client.host if http_request.client else "unknown"
    logger.debug(f"[SandboxAPI] List executions: sandbox {sandbox_id} from {client_ip}")

    manager = get_sandbox_manager()
    executions, error = await manager.list_executions(sandbox_id)

    if error:
        raise HTTPException(
            status_code=404,
            detail=error,
        )

    return ListExecutionsResponse(
        executions=[
            ExecutionStatusResponse(
                execution_id=e.execution_id,
                sandbox_id=e.sandbox_id,
                status=e.status.value,
                prompt=(e.prompt[:200] + "..." if len(e.prompt) > 200 else e.prompt),
                result=e.result,
                error_message=e.error_message,
                progress=e.progress,
                created_at=e.created_at,
                started_at=e.started_at,
                completed_at=e.completed_at,
                execution_time=e.execution_time,
                metadata=e.metadata,
            )
            for e in executions
        ],
        sandbox_id=sandbox_id,
        total=len(executions),
    )


# =============================================================================
# Heartbeat Endpoint
# =============================================================================


@router.post("/{sandbox_id}/heartbeat")
async def sandbox_heartbeat(sandbox_id: str, http_request: Request):
    """Receive heartbeat from executor container.

    This endpoint is called periodically by the executor's heartbeat service
    to signal that the container is still alive and healthy.

    Args:
        sandbox_id: Unique sandbox identifier (task_id as string)
        http_request: HTTP request object

    Returns:
        dict with status confirmation
    """
    client_ip = http_request.client.host if http_request.client else "unknown"
    logger.debug(
        f"[SandboxAPI] Heartbeat received: sandbox_id={sandbox_id} from {client_ip}"
    )

    from executor_manager.services.heartbeat_manager import \
        get_heartbeat_manager

    heartbeat_mgr = get_heartbeat_manager()
    success = heartbeat_mgr.update_heartbeat(sandbox_id)

    if not success:
        logger.warning(
            f"[SandboxAPI] Failed to update heartbeat for sandbox {sandbox_id}"
        )
        raise HTTPException(
            status_code=500,
            detail="Failed to update heartbeat",
        )

    return {"status": "ok", "sandbox_id": sandbox_id}
