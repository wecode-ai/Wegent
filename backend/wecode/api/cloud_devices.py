# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Cloud device API endpoints.

Provides endpoints for creating, deleting, and querying cloud devices
managed through Nevis Sandbox API.
"""

import logging

from fastapi import APIRouter, Body, Depends, HTTPException, Request, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.core.config import settings
from app.models.user import User
from wecode.config.nevis_config import nevis_settings
from wecode.schemas.cloud_device import (
    CloudDeviceResponse,
    CreateCloudDeviceRequest,
    NevisSandboxStatus,
    VncConfigResponse,
)
from wecode.service.cloud_device_provider import cloud_device_provider
from wecode.service.nevis_client import NevisClient, NevisClientError

logger = logging.getLogger(__name__)

router = APIRouter()


def _get_backend_url(request: Request) -> str:
    """Get backend URL from request or settings.

    Args:
        request: FastAPI request object

    Returns:
        Backend URL for executor to connect
    """
    # Try NEVIS_CALLBACK_URL first, then BACKEND_INTERNAL_URL
    if nevis_settings.NEVIS_CALLBACK_URL:
        return nevis_settings.NEVIS_CALLBACK_URL
    if settings.BACKEND_INTERNAL_URL:
        return settings.BACKEND_INTERNAL_URL

    # Fall back to request host
    scheme = request.url.scheme
    host = request.headers.get("host", request.url.netloc)
    return f"{scheme}://{host}"


@router.post("", response_model=CloudDeviceResponse)
async def create_cloud_device(
    request: Request,
    body: CreateCloudDeviceRequest = Body(default=CreateCloudDeviceRequest()),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """Create a new cloud device via Nevis Sandbox API.

    Creates a VM with pre-installed wegent-executor that will automatically
    connect to the backend via WebSocket.

    Returns:
        CloudDeviceResponse with device info

    Raises:
        HTTPException 400: If cloud device limit reached
        HTTPException 500: If Nevis API call fails
        HTTPException 503: If cloud device provider not configured
    """
    # Check if provider is configured
    if not cloud_device_provider.is_configured():
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Cloud device provider is not configured",
        )

    # Check if user is in whitelist
    if not nevis_settings.can_create_cloud_device(current_user.user_name):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You are not authorized to create cloud devices",
        )

    try:
        # Get backend URL for executor to connect
        backend_url = _get_backend_url(request)

        # Get user's API key for executor authentication
        from wecode.service.api_key_service import create_api_key_for_cloud_device

        _, auth_token = create_api_key_for_cloud_device(
            db, current_user.id, current_user.user_name
        )

        result = await cloud_device_provider.create_device(
            db=db,
            user_id=current_user.id,
            user_name=current_user.user_name,
            auth_token=auth_token,
            backend_url=backend_url,
            mail_email=body.mail_email or "",
            mail_password=body.mail_password or "",
        )

        return CloudDeviceResponse(**result)

    except ValueError as e:
        error_msg = str(e)
        if "limit reached" in error_msg.lower():
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={
                    "message": error_msg,
                    "max_devices": nevis_settings.NEVIS_MAX_DEVICES_PER_USER,
                },
            )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=error_msg,
        )

    except NevisClientError as e:
        logger.error(f"Nevis API error creating cloud device: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to create cloud device: {str(e)}",
        )

    except Exception as e:
        logger.exception(f"Unexpected error creating cloud device: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to create cloud device",
        )


@router.delete("/{device_id}")
async def delete_cloud_device(
    device_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """Delete a cloud device.

    Deletes the VM via Nevis API and removes the device record.

    Args:
        device_id: Cloud device ID (sandbox ID)

    Returns:
        Success message

    Raises:
        HTTPException 404: If device not found
        HTTPException 500: If Nevis API call fails
    """
    try:
        success = await cloud_device_provider.delete_device(
            db=db,
            user_id=current_user.id,
            device_id=device_id,
        )

        if not success:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Cloud device '{device_id}' not found",
            )

        return {"message": f"Cloud device '{device_id}' deleted successfully"}

    except HTTPException:
        raise

    except NevisClientError as e:
        logger.error(f"Nevis API error deleting cloud device: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to delete cloud device: {str(e)}",
        )

    except Exception as e:
        logger.exception(f"Unexpected error deleting cloud device: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to delete cloud device",
        )


@router.get("/{device_id}/status", response_model=NevisSandboxStatus)
async def get_cloud_device_nevis_status(
    device_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """Get Nevis sandbox status for a cloud device.

    Queries Nevis API for the VM's current status, including IP address.
    Accepts either the current device_id (UUID) or the original sandbox ID.
    Internally resolves to sandbox ID from cloudConfig for the Nevis API call.

    Args:
        device_id: Cloud device ID (UUID or sandbox ID)

    Returns:
        NevisSandboxStatus with VM status info

    Raises:
        HTTPException 404: If device not found
        HTTPException 500: If Nevis API call fails
    """
    # Verify device exists and belongs to user
    device_status = await cloud_device_provider.get_status(
        db=db,
        user_id=current_user.id,
        device_id=device_id,
    )

    if not device_status:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Cloud device '{device_id}' not found",
        )

    # Resolve sandbox ID from cloud_config (device_id may be UUID after executor registration)
    cloud_config = device_status.get("cloud_config") or {}
    sandbox_id = cloud_config.get("sandboxId", device_id)

    try:
        nevis_status = await cloud_device_provider.get_vm_status(sandbox_id)
        return NevisSandboxStatus(**nevis_status)

    except NevisClientError as e:
        if e.status_code == 404:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Nevis sandbox '{device_id}' not found",
            )
        logger.error(f"Nevis API error getting status: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to get cloud device status: {str(e)}",
        )

    except Exception as e:
        logger.exception(f"Unexpected error getting cloud device status: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to get cloud device status",
        )


@router.get("/{device_id}/vnc-config", response_model=VncConfigResponse)
async def get_vnc_config(
    device_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """Get VNC WebSocket connection configuration for a cloud device.

    Returns the upstream WSS URL and authentication signature needed
    by server.cjs to proxy VNC WebSocket connections to Nevis.

    Args:
        device_id: Cloud device ID (UUID or sandbox ID)

    Returns:
        VncConfigResponse with wss_url, signature, and sandbox_id

    Raises:
        HTTPException 404: If device not found
        HTTPException 503: If Nevis is not configured
    """
    if not cloud_device_provider.is_configured():
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Cloud device provider is not configured",
        )

    # Verify device exists and belongs to user
    device_status = await cloud_device_provider.get_status(
        db=db,
        user_id=current_user.id,
        device_id=device_id,
    )

    if not device_status:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Cloud device '{device_id}' not found",
        )

    # Resolve sandbox ID from cloud_config
    cloud_config = device_status.get("cloud_config") or {}
    sandbox_id = cloud_config.get("sandboxId", device_id)

    # Build upstream VNC WebSocket URL from Nevis settings
    base_url = nevis_settings.NEVIS_BASE_URL.rstrip("/")
    # Convert http(s):// to ws(s)://
    if base_url.startswith("https://"):
        wss_base = "wss://" + base_url[len("https://") :]
    elif base_url.startswith("http://"):
        wss_base = "ws://" + base_url[len("http://") :]
    else:
        wss_base = "wss://" + base_url

    manager_id = nevis_settings.NEVIS_MANAGER_ID
    wss_url = (
        f"{wss_base}/apis/sandboxes/v1/managers/{manager_id}"
        f"/sandboxes/{sandbox_id}/vnc"
    )

    return VncConfigResponse(
        wss_url=wss_url,
        signature=nevis_settings.NEVIS_SIGNATURE,
        sandbox_id=sandbox_id,
    )


@router.get("/config")
async def get_cloud_device_config(
    current_user: User = Depends(security.get_current_user),
):
    """Get cloud device configuration info.

    Returns current configuration and limits for cloud devices.

    Returns:
        Configuration info including max devices and availability
    """
    return {
        "enabled": cloud_device_provider.is_configured(),
        "max_devices_per_user": nevis_settings.NEVIS_MAX_DEVICES_PER_USER,
        "can_create": nevis_settings.can_create_cloud_device(current_user.user_name),
    }
