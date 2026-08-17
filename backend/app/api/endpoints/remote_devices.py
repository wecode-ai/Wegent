# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Remote device onboarding endpoints."""

import logging
import uuid
from typing import Dict, Literal, Optional

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.models.user import User
from app.services.api_key_service import create_api_key_for_remote_device
from app.services.device.remote_device_startup import (
    RemoteDeviceCommandContext,
    get_remote_device_command_provider,
)

logger = logging.getLogger(__name__)

router = APIRouter()

DEFAULT_REMOTE_DEVICE_CONTAINER_NAME = "wegent-remote-device"


class CreateDockerRemoteDeviceRequest(BaseModel):
    """Request for generating a Docker remote device command."""

    client_origin: Optional[str] = Field(
        default=None,
        description="Current browser origin used to derive the device access URL.",
    )
    container_name: str = Field(
        default=DEFAULT_REMOTE_DEVICE_CONTAINER_NAME,
        min_length=1,
        max_length=128,
        description="Docker container name used in the generated command.",
    )


class RemoteDeviceStartupCommand(BaseModel):
    """A generated startup command for a remote device."""

    kind: Literal["docker", "process"]
    label: str
    description: str | None = None
    command: str


class DockerRemoteDeviceCommandResponse(BaseModel):
    """Generated remote device startup commands."""

    device_id: str
    name: str
    image: str
    env: Dict[str, str]
    command: str
    commands: list[RemoteDeviceStartupCommand] = Field(default_factory=list)


@router.post(
    "/docker/start-command",
    response_model=DockerRemoteDeviceCommandResponse,
)
async def create_docker_start_command(
    request: Request,
    body: Optional[CreateDockerRemoteDeviceRequest] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> DockerRemoteDeviceCommandResponse:
    """Create credentials and delegate startup command construction."""
    body = body or CreateDockerRemoteDeviceRequest()
    device_id = str(uuid.uuid4())
    device_name = f"{current_user.user_name}-remote-{device_id.split('-')[-1]}"
    _, auth_token = create_api_key_for_remote_device(
        db,
        current_user.id,
        current_user.user_name,
    )

    result = get_remote_device_command_provider().build(
        RemoteDeviceCommandContext(
            container_name=body.container_name,
            client_origin=body.client_origin,
            request_scheme=request.url.scheme,
            request_netloc=request.url.netloc,
            request_headers={
                name: value
                for name in ("host", "origin", "referer")
                if (value := request.headers.get(name)) is not None
            },
            device_id=device_id,
            device_name=device_name,
            auth_token=auth_token,
        )
    )

    logger.info(
        "[RemoteDevice] Startup command generated: user_id=%s, device_id=%s",
        current_user.id,
        device_id,
    )

    return DockerRemoteDeviceCommandResponse(
        device_id=device_id,
        name=device_name,
        image=result.image,
        env=result.env,
        command=result.command,
        commands=[
            RemoteDeviceStartupCommand(
                kind=command.kind,
                label=command.label,
                description=command.description,
                command=command.command,
            )
            for command in result.commands
        ],
    )
