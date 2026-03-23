# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Internal device APIs for service-to-service communication."""

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.api.endpoints.devices import DeviceSandboxExecResponse

router = APIRouter(prefix="/devices", tags=["internal-devices"])


class InternalDeviceSandboxExecRequest(BaseModel):
    """Internal request model for device-backed command execution."""

    user_id: int = Field(..., ge=1, description="Owner user ID")
    command: str = Field(..., min_length=1, description="Command to execute")
    working_dir: str = Field(
        default="/home/user",
        description="Working directory for command execution",
    )
    timeout_seconds: int = Field(
        default=300,
        ge=1,
        le=1800,
        description="Command timeout in seconds",
    )
    required_capability: str | None = Field(
        default=None,
        description="Optional device capability required for routing",
    )
    device_id: str | None = Field(
        default=None,
        description="Optional explicit device ID override",
    )


@router.post("/sandbox/exec", response_model=DeviceSandboxExecResponse)
async def execute_device_sandbox_command_internal(
    request: InternalDeviceSandboxExecRequest,
    db: Session = Depends(get_db),
) -> DeviceSandboxExecResponse:
    """Execute a command on a user's device for internal trusted services."""
    from app.services.device_sandbox_service import (
        DeviceSandboxError,
        device_sandbox_service,
    )

    try:
        result = await device_sandbox_service.execute_command(
            db=db,
            user_id=request.user_id,
            command=request.command,
            working_dir=request.working_dir,
            timeout_seconds=request.timeout_seconds,
            required_capability=request.required_capability,
            device_id=request.device_id,
        )
    except DeviceSandboxError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc

    return DeviceSandboxExecResponse(**result)
