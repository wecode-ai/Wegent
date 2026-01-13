# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""E2B Standard API routes.

This module implements the E2B standard REST API for sandbox management:
- POST   /sandboxes                  - Create a new sandbox (201)
- GET    /v2/sandboxes               - List sandboxes with filters
- GET    /sandboxes/{sandboxID}      - Get sandbox details
- DELETE /sandboxes/{sandboxID}      - Delete sandbox (204)
- POST   /sandboxes/{sandboxID}/timeout - Set timeout (204)
- POST   /sandboxes/{sandboxID}/pause   - Pause sandbox (204)
- POST   /sandboxes/{sandboxID}/resume  - Resume sandbox (204)
- POST   /sandboxes/{sandboxID}/connect - Connect to sandbox (200/201)

All responses follow E2B standard format with camelCase field names.
Authentication is done via X-API-KEY header.
"""

import os
import uuid
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from shared.logger import setup_logger

from executor_manager.models.sandbox import SandboxStatus
from executor_manager.services.sandbox import get_sandbox_manager

logger = setup_logger(__name__)

# Create router - no prefix here, will be set when including in app
router = APIRouter(tags=["e2b"])

# Expected API key from environment
E2B_API_KEY = os.getenv("E2B_API_KEY", "test-api-key")


# =============================================================================
# Authentication
# =============================================================================


async def verify_api_key(x_api_key: Optional[str] = Header(None, alias="X-API-KEY")):
    """Verify X-API-KEY header for authentication.

    Args:
        x_api_key: API key from X-API-KEY header

    Raises:
        HTTPException: If API key is missing or invalid
    """
    # If E2B_API_KEY is not set, skip authentication (for development)
    if not E2B_API_KEY:
        return

    if not x_api_key:
        raise HTTPException(
            status_code=401,
            detail={"code": "unauthorized", "message": "Missing X-API-KEY header"},
        )

    if x_api_key != E2B_API_KEY:
        raise HTTPException(
            status_code=401,
            detail={"code": "unauthorized", "message": "Invalid API key"},
        )


# =============================================================================
# Request/Response Schemas (E2B Standard Format - camelCase)
# =============================================================================


class CreateSandboxRequest(BaseModel):
    """Request body for creating a new sandbox (E2B format)."""

    templateId: Optional[str] = Field(
        default=None,
        description="Template ID (E2B protocol field, currently unused)",
    )
    timeout: Optional[int] = Field(
        default=1800,
        description="Sandbox timeout in seconds",
        ge=60,
        le=86400,
    )
    metadata: Optional[Dict[str, Any]] = Field(
        default=None,
        description="Additional metadata for the sandbox",
    )


class SetTimeoutRequest(BaseModel):
    """Request body for setting sandbox timeout."""

    timeout: int = Field(
        ...,
        description="New timeout in seconds from now",
        ge=60,
        le=86400,
    )


class SandboxResponse(BaseModel):
    """E2B standard sandbox response (camelCase)."""

    sandboxID: str = Field(..., description="Unique sandbox identifier")
    templateID: str = Field(..., description="Template ID (shell type)")
    alias: Optional[str] = Field(None, description="Sandbox alias")
    clientID: str = Field(..., description="Client ID")
    state: str = Field(..., description="Sandbox state")
    startedAt: Optional[str] = Field(None, description="ISO timestamp when started")
    endAt: Optional[str] = Field(None, description="ISO timestamp when will end")
    metadata: Optional[Dict[str, Any]] = Field(None, description="Sandbox metadata")
    # Additional E2B fields
    envdVersion: str = Field(default="0.1.1", description="Envd version")
    envdAccessToken: Optional[str] = Field(None, description="Envd access token")
    domain: Optional[str] = Field(None, description="Sandbox domain")
    cpuCount: int = Field(default=2, description="CPU count")
    memoryMB: int = Field(default=512, description="Memory in MB")
    diskSizeMB: int = Field(default=10240, description="Disk size in MB")


class ListSandboxesResponse(BaseModel):
    """Response for listing sandboxes."""

    sandboxes: List[SandboxResponse] = Field(
        default_factory=list, description="List of sandboxes"
    )


class ErrorResponse(BaseModel):
    """E2B standard error response."""

    code: str = Field(..., description="Error code")
    message: str = Field(..., description="Error message")


# =============================================================================
# Helper Functions
# =============================================================================


def sandbox_status_to_e2b_state(status: SandboxStatus) -> str:
    """Convert internal SandboxStatus to E2B state string.

    Args:
        status: Internal sandbox status

    Returns:
        E2B state string (running, paused, stopped)
    """
    status_map = {
        SandboxStatus.PENDING: "starting",
        SandboxStatus.RUNNING: "running",
        SandboxStatus.SUCCEEDED: "stopped",
        SandboxStatus.FAILED: "stopped",
        SandboxStatus.TERMINATING: "stopping",
        SandboxStatus.TERMINATED: "stopped",
    }
    return status_map.get(status, "unknown")


def timestamp_to_iso(timestamp: Optional[float]) -> Optional[str]:
    """Convert Unix timestamp to ISO 8601 string.

    Args:
        timestamp: Unix timestamp

    Returns:
        ISO 8601 formatted string or None
    """
    if timestamp is None:
        return None
    from datetime import datetime, timezone

    return datetime.fromtimestamp(timestamp, tz=timezone.utc).isoformat()


def get_domain_from_request(http_request: Request) -> str:
    """Extract domain with protocol from request.

    The domain is used by SDK to construct sandbox URLs.
    For private protocol, SDK will use: domain/executor_manager/<sid>/<port>

    Args:
        http_request: FastAPI Request object

    Returns:
        Domain string with protocol (e.g., "http://127.0.0.1:8001")
    """
    # Determine protocol from request
    scheme = http_request.url.scheme or "http"
    logger.info(f"[get_domain_from_request] url.scheme={http_request.url.scheme}")

    # Check X-Forwarded-Proto header (for reverse proxy)
    forwarded_proto = http_request.headers.get("x-forwarded-proto")
    if forwarded_proto:
        scheme = forwarded_proto
        logger.info(
            f"[get_domain_from_request] using x-forwarded-proto={forwarded_proto}"
        )

    # Get Host header (includes port if non-standard)
    host = http_request.headers.get("host", "")
    logger.info(f"[get_domain_from_request] host header={host}")

    if not host:
        # Fallback: construct from request URL
        url = http_request.url
        if url.port and url.port not in (80, 443):
            host = f"{url.hostname}:{url.port}"
        else:
            host = url.hostname or "localhost"
        logger.info(f"[get_domain_from_request] fallback host={host}")

    result = f"{scheme}://{host}"
    logger.info(f"[get_domain_from_request] returning domain={result}")
    return result


def sandbox_to_e2b_response(sandbox, domain: str = "localhost") -> Dict[str, Any]:
    """Convert internal Sandbox to E2B response format.

    Args:
        sandbox: Internal Sandbox object
        domain: Domain for sandbox access (should be host:port, no protocol)

    Returns:
        Dictionary in E2B response format (camelCase with uppercase ID)
    """
    import uuid as uuid_module

    # Generate envd access token
    envd_access_token = str(uuid_module.uuid4())

    return {
        "sandboxID": sandbox.sandbox_id,
        "templateID": sandbox.shell_type,
        "alias": sandbox.container_name or "",
        "clientID": str(sandbox.user_id) if sandbox.user_id else "0",
        "state": sandbox_status_to_e2b_state(sandbox.status),
        "startedAt": timestamp_to_iso(sandbox.started_at)
        or timestamp_to_iso(sandbox.created_at),
        "endAt": timestamp_to_iso(sandbox.expires_at),
        "metadata": sandbox.metadata or {},
        # Additional E2B required fields
        "envdVersion": "0.1.1",
        "envdAccessToken": envd_access_token,
        "domain": domain,
        "cpuCount": 2,
        "memoryMB": 512,
        "diskSizeMB": 10240,
    }


# =============================================================================
# E2B Standard Endpoints
# =============================================================================


@router.post("/sandboxes", status_code=201, dependencies=[Depends(verify_api_key)])
async def create_sandbox(
    request: CreateSandboxRequest,
    http_request: Request,
):
    """Create a new sandbox (E2B standard).

    Creates an isolated execution environment. Returns 201 on success.

    Args:
        request: Sandbox creation parameters
        http_request: HTTP request object

    Returns:
        SandboxResponse with sandbox details
    """
    client_ip = http_request.client.host if http_request.client else "unknown"
    logger.info(
        f"[E2B API] Create sandbox: templateId={request.templateId}, "
        f"timeout={request.timeout}s from {client_ip}"
    )

    # Build metadata
    metadata = request.metadata or {}

    # Get shell_type from bot_config in metadata
    bot_config = metadata.get("bot_config", [])
    if isinstance(bot_config, list) and bot_config:
        shell_type = bot_config[0].get("shell_type", "ClaudeCode")
    else:
        shell_type = "ClaudeCode"

    # Check if task_id is provided in metadata, otherwise generate one
    if "task_id" in metadata:
        # Use provided task_id as sandbox_id
        task_id = int(metadata["task_id"])
        # Generate e2b_sandbox_id from task_id for E2B protocol compatibility
        sandbox_uuid = str(task_id)
        logger.info(f"[E2B API] Using provided task_id as sandbox_id: {task_id}")
    else:
        # Generate UUID for sandbox_id
        sandbox_uuid = str(uuid.uuid4())
        # Use sandbox_uuid hash as task_id (needs to be int for internal compatibility)
        task_id = abs(hash(sandbox_uuid)) % (10**9)  # Ensure positive int
        metadata["task_id"] = task_id
        logger.info(f"[E2B API] Generated task_id: {task_id}")

    metadata["e2b_sandbox_id"] = sandbox_uuid

    # Extract user info from metadata if provided, otherwise use defaults
    user_id = metadata.get("user_id", 0)
    user_name = metadata.get("user_name", "e2b")

    manager = get_sandbox_manager()
    sandbox, error = await manager.create_sandbox(
        shell_type=shell_type,
        user_id=user_id,
        user_name=user_name,
        timeout=request.timeout,
        metadata=metadata,
    )

    if sandbox is None:
        raise HTTPException(
            status_code=500,
            detail={"code": "creation_failed", "message": error or "Unknown error"},
        )

    if error:
        # Sandbox created but with error
        logger.warning(f"[E2B API] Sandbox created with error: {error}")

    # Get domain from request for SDK to construct URLs
    domain = get_domain_from_request(http_request)

    # Override sandbox_id with UUID for E2B compatibility
    response_data = sandbox_to_e2b_response(sandbox, domain=domain)
    response_data["sandboxID"] = sandbox_uuid

    logger.info(f"[E2B API] Sandbox created: {sandbox_uuid}, domain={domain}")
    return JSONResponse(status_code=201, content=response_data)


@router.get("/v2/sandboxes", dependencies=[Depends(verify_api_key)])
async def list_sandboxes(
    http_request: Request,
    state: Optional[str] = Query(None, description="Filter by state"),
    metadata: Optional[str] = Query(
        None, description="Filter by metadata (key=value format)"
    ),
):
    """List sandboxes with optional filters (E2B v2 standard).

    Args:
        http_request: HTTP request object
        state: Optional state filter (running, paused, stopped)
        metadata: Optional metadata filter in key=value format

    Returns:
        List of sandboxes matching filters
    """
    client_ip = http_request.client.host if http_request.client else "unknown"
    logger.info(
        f"[E2B API] List sandboxes: state={state}, metadata={metadata} from {client_ip}"
    )

    manager = get_sandbox_manager()
    repository = manager._repository

    # Get all active sandbox IDs
    sandbox_ids = repository.get_active_sandbox_ids()
    sandboxes = []

    for sandbox_id in sandbox_ids:
        sandbox = repository.load_sandbox(sandbox_id)
        if sandbox is None:
            continue

        # Apply state filter
        if state:
            sandbox_state = sandbox_status_to_e2b_state(sandbox.status)
            if sandbox_state != state:
                continue

        # Apply metadata filter
        if metadata:
            try:
                key, value = metadata.split("=", 1)
                sandbox_metadata = sandbox.metadata or {}
                if str(sandbox_metadata.get(key)) != value:
                    continue
            except ValueError:
                # Invalid metadata format, skip filter
                pass

        sandboxes.append(sandbox_to_e2b_response(sandbox))

    return sandboxes


@router.get("/sandboxes/{sandbox_id}", dependencies=[Depends(verify_api_key)])
async def get_sandbox(sandbox_id: str, http_request: Request):
    """Get sandbox details by ID (E2B standard).

    Args:
        sandbox_id: Sandbox UUID
        http_request: HTTP request object

    Returns:
        SandboxResponse with sandbox details
    """
    client_ip = http_request.client.host if http_request.client else "unknown"
    logger.debug(f"[E2B API] Get sandbox: {sandbox_id} from {client_ip}")

    manager = get_sandbox_manager()

    # Try to find sandbox by e2b_sandbox_id in metadata
    sandbox = await _find_sandbox_by_e2b_id(manager, sandbox_id)

    if sandbox is None:
        # Fallback: try direct lookup (for internal sandbox_id)
        sandbox = await manager.get_sandbox(sandbox_id)

    if sandbox is None:
        raise HTTPException(
            status_code=404,
            detail={
                "code": "not_found",
                "message": f"Sandbox {sandbox_id} not found",
            },
        )

    response_data = sandbox_to_e2b_response(sandbox)
    # Use the requested sandbox_id in response
    if sandbox.metadata.get("e2b_sandbox_id"):
        response_data["sandboxID"] = sandbox.metadata["e2b_sandbox_id"]

    return response_data


@router.delete(
    "/sandboxes/{sandbox_id}", status_code=204, dependencies=[Depends(verify_api_key)]
)
async def delete_sandbox(sandbox_id: str, http_request: Request):
    """Delete/terminate a sandbox (E2B standard).

    Returns 204 on success with no content.

    Args:
        sandbox_id: Sandbox UUID
        http_request: HTTP request object
    """
    client_ip = http_request.client.host if http_request.client else "unknown"
    logger.info(f"[E2B API] Delete sandbox: {sandbox_id} from {client_ip}")

    manager = get_sandbox_manager()

    # Find sandbox by e2b_sandbox_id
    sandbox = await _find_sandbox_by_e2b_id(manager, sandbox_id)
    if sandbox is None:
        # Fallback: try direct lookup
        sandbox = await manager.get_sandbox(sandbox_id, check_health=False)

    if sandbox is None:
        raise HTTPException(
            status_code=404,
            detail={
                "code": "not_found",
                "message": f"Sandbox {sandbox_id} not found",
            },
        )

    success, message = await manager.terminate_sandbox(sandbox.sandbox_id)
    if not success:
        raise HTTPException(
            status_code=500,
            detail={"code": "termination_failed", "message": message},
        )

    # Return 204 No Content
    return JSONResponse(status_code=204, content=None)


@router.post(
    "/sandboxes/{sandbox_id}/timeout",
    status_code=204,
    dependencies=[Depends(verify_api_key)],
)
async def set_sandbox_timeout(
    sandbox_id: str,
    request: SetTimeoutRequest,
    http_request: Request,
):
    """Set sandbox timeout (E2B standard).

    Sets a new timeout for the sandbox. Returns 204 on success.

    Args:
        sandbox_id: Sandbox UUID
        request: Timeout parameters
        http_request: HTTP request object
    """
    client_ip = http_request.client.host if http_request.client else "unknown"
    logger.info(
        f"[E2B API] Set timeout: {sandbox_id}, timeout={request.timeout}s from {client_ip}"
    )

    manager = get_sandbox_manager()

    # Find sandbox
    sandbox = await _find_sandbox_by_e2b_id(manager, sandbox_id)
    if sandbox is None:
        sandbox = await manager.get_sandbox(sandbox_id, check_health=False)

    if sandbox is None:
        raise HTTPException(
            status_code=404,
            detail={
                "code": "not_found",
                "message": f"Sandbox {sandbox_id} not found",
            },
        )

    # Extend timeout
    updated_sandbox, error = await manager.keep_alive(
        sandbox.sandbox_id, request.timeout
    )
    if error:
        raise HTTPException(
            status_code=400,
            detail={"code": "timeout_failed", "message": error},
        )

    return JSONResponse(status_code=204, content=None)


@router.post(
    "/sandboxes/{sandbox_id}/pause",
    status_code=204,
    dependencies=[Depends(verify_api_key)],
)
async def pause_sandbox(sandbox_id: str, http_request: Request):
    """Pause a sandbox (E2B standard).

    Note: Pause is not fully implemented yet. Returns 204 but sandbox
    remains in current state. Future implementation will pause the
    container.

    Args:
        sandbox_id: Sandbox UUID
        http_request: HTTP request object
    """
    client_ip = http_request.client.host if http_request.client else "unknown"
    logger.info(f"[E2B API] Pause sandbox: {sandbox_id} from {client_ip}")

    manager = get_sandbox_manager()

    # Find sandbox
    sandbox = await _find_sandbox_by_e2b_id(manager, sandbox_id)
    if sandbox is None:
        sandbox = await manager.get_sandbox(sandbox_id)

    if sandbox is None:
        raise HTTPException(
            status_code=404,
            detail={
                "code": "not_found",
                "message": f"Sandbox {sandbox_id} not found",
            },
        )

    if sandbox.status != SandboxStatus.RUNNING:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "invalid_state",
                "message": f"Sandbox is not running (state: {sandbox.status.value})",
            },
        )

    # TODO: Implement actual pause logic (docker pause)
    # For now, just log and return success
    logger.warning(
        f"[E2B API] Pause not fully implemented for sandbox {sandbox_id}, "
        "sandbox remains running"
    )

    return JSONResponse(status_code=204, content=None)


@router.post(
    "/sandboxes/{sandbox_id}/resume",
    status_code=204,
    dependencies=[Depends(verify_api_key)],
)
async def resume_sandbox(sandbox_id: str, http_request: Request):
    """Resume a paused sandbox (E2B standard).

    Note: Resume is not fully implemented yet. Returns 204 but expects
    sandbox to be in paused state. Future implementation will unpause
    the container.

    Args:
        sandbox_id: Sandbox UUID
        http_request: HTTP request object
    """
    client_ip = http_request.client.host if http_request.client else "unknown"
    logger.info(f"[E2B API] Resume sandbox: {sandbox_id} from {client_ip}")

    manager = get_sandbox_manager()

    # Find sandbox
    sandbox = await _find_sandbox_by_e2b_id(manager, sandbox_id)
    if sandbox is None:
        sandbox = await manager.get_sandbox(sandbox_id)

    if sandbox is None:
        raise HTTPException(
            status_code=404,
            detail={
                "code": "not_found",
                "message": f"Sandbox {sandbox_id} not found",
            },
        )

    # TODO: Implement actual resume logic (docker unpause)
    # For now, just check state and return success
    logger.warning(f"[E2B API] Resume not fully implemented for sandbox {sandbox_id}")

    return JSONResponse(status_code=204, content=None)


@router.post("/sandboxes/{sandbox_id}/connect", dependencies=[Depends(verify_api_key)])
async def connect_to_sandbox(sandbox_id: str, http_request: Request):
    """Connect to a sandbox (E2B standard).

    Returns 200 if sandbox is already running, 201 if sandbox was resumed
    from paused state.

    Args:
        sandbox_id: Sandbox UUID
        http_request: HTTP request object

    Returns:
        SandboxResponse with sandbox details
    """
    client_ip = http_request.client.host if http_request.client else "unknown"
    logger.info(f"[E2B API] Connect to sandbox: {sandbox_id} from {client_ip}")

    manager = get_sandbox_manager()

    # Find sandbox
    sandbox = await _find_sandbox_by_e2b_id(manager, sandbox_id)
    if sandbox is None:
        sandbox = await manager.get_sandbox(sandbox_id)

    if sandbox is None:
        raise HTTPException(
            status_code=404,
            detail={
                "code": "not_found",
                "message": f"Sandbox {sandbox_id} not found",
            },
        )

    response_data = sandbox_to_e2b_response(sandbox)
    if sandbox.metadata.get("e2b_sandbox_id"):
        response_data["sandboxID"] = sandbox.metadata["e2b_sandbox_id"]

    # Determine status code based on sandbox state
    if sandbox.status == SandboxStatus.RUNNING:
        # Already running
        return JSONResponse(status_code=200, content=response_data)
    else:
        # TODO: Implement resume from paused state
        # For now, return 200 with current state
        logger.warning(
            f"[E2B API] Sandbox {sandbox_id} is in state {sandbox.status.value}, "
            "connect returning current state"
        )
        return JSONResponse(status_code=200, content=response_data)


# =============================================================================
# Helper Functions
# =============================================================================


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
