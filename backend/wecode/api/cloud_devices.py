# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Cloud device API endpoints.

Provides endpoints for creating, deleting, and querying cloud devices
managed through Nevis Sandbox API.
"""

import asyncio
import logging
from typing import Any

import httpx
from fastapi import (
    APIRouter,
    BackgroundTasks,
    Body,
    Depends,
    HTTPException,
    Request,
    status,
)
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from app.api.dependencies import get_db
from app.core import security
from app.core.config import settings
from app.models.user import User
from wecode.config.nevis_config import nevis_settings
from wecode.schemas.cloud_device import (
    CloudDeviceFileConfigResponse,
    CloudDeviceMetricsResponse,
    CloudDeviceResponse,
    CreateCloudDeviceRequest,
    NevisSandboxStatus,
)
from wecode.service.cloud_device_git_tokens import build_cloud_device_git_accounts
from wecode.service.cloud_device_ip_index import (
    CloudDeviceIpTarget,
    cloud_device_ip_index_service,
    normalize_nevis_ip,
)
from wecode.service.cloud_device_provider import cloud_device_provider
from wecode.service.get_user_gitinfo import (
    GitTokenNotConfiguredError,
    GitTokenRejectedError,
    GitTokenSourceUnavailableError,
    GitTokenValidationUnavailableError,
    get_user_gitinfo,
)
from wecode.service.nevis_client import NevisClientError

logger = logging.getLogger(__name__)

router = APIRouter()
FILES_SERVICE_TIMEOUT = 3.0

# Nevis metric queries shared by the real-time and history endpoints.
# Disk is filtered to the root filesystem; otherwise Nevis returns one series
# per mountpoint (/boot/efi, tmpfs, ...) and data[0] may be the tiny EFI
# partition instead of the real root disk.
METRIC_QUERIES: dict[str, str] = {
    "cpu": "max_over_time(syscpuidle:busy{cpu='cpu'})",
    "memory": "max_over_time(sysmeminfo:memused_percentage)",
    "disk": 'max_over_time(sysdiskinfo:used_size_percentage{mountpoint="/"})',
}


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


def _get_bearer_token(request: Request) -> str:
    """Extract the raw Bearer token from the incoming request."""
    authorization = request.headers.get("authorization", "")
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer":
        return ""
    return token.strip()


async def _get_current_user_git_tokens(user_name: str) -> list[dict[str, Any]]:
    """Fetch the user's Git accounts for the cloud device, tolerating their absence.

    Git credentials configure the commit identity inside a device; they are not a
    precondition for having one. Resolving them fails for reasons that say nothing
    about whether a device can be built -- the user never configured a token, the
    stored one was revoked, the credential service is down -- and treating any of
    those as fatal denies a cloud device to someone who did nothing wrong. Every
    failure degrades to "no Git identity"; the reason is logged, not returned.
    """
    try:
        git_tokens = await run_in_threadpool(
            get_user_gitinfo.get_validated_real_git_tokens,
            user_name,
        )
    except (
        GitTokenNotConfiguredError,
        GitTokenRejectedError,
        GitTokenSourceUnavailableError,
        GitTokenValidationUnavailableError,
    ) as error:
        logger.warning(
            "[CloudDevice] Creating without Git credentials: user_name=%s, "
            "error_type=%s",
            user_name,
            type(error).__name__,
        )
        return []

    git_accounts = build_cloud_device_git_accounts(git_tokens)
    identity_warning_domains = [
        account["domain"]
        for account in git_accounts
        if not account["identity_name"] or not account["identity_email"]
    ]
    if identity_warning_domains:
        logger.warning(
            "[CloudDevice] Git commit identity is incomplete: "
            "user_name=%s, domains=%s",
            user_name,
            ",".join(identity_warning_domains),
        )
    return git_accounts


def _resolve_target_user_id(
    current_user: User,
    target_user_id: int | None,
) -> int:
    """Resolve the target owner for cloud device access.

    Non-admin users can only access their own devices. Admin users may
    explicitly target another owner's device by passing ``user_id``.
    """
    if target_user_id is None or target_user_id == current_user.id:
        return current_user.id

    if getattr(current_user, "role", "user") != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only admins can access another user's cloud device",
        )

    return target_user_id


async def _get_accessible_cloud_device_status(
    device_id: str,
    db: Session,
    current_user: User,
    target_user_id: int | None = None,
) -> dict[str, Any]:
    """Load a cloud device status payload and validate access."""
    resolved_user_id = _resolve_target_user_id(current_user, target_user_id)
    device_status = await cloud_device_provider.get_status(
        db=db,
        user_id=resolved_user_id,
        device_id=device_id,
    )
    if not device_status:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Cloud device '{device_id}' not found",
        )
    return device_status


def _resolve_sandbox_id(device_id: str, device_status: dict[str, Any]) -> str:
    """Resolve the Nevis sandbox ID from cloud device status."""
    cloud_config = device_status.get("cloud_config") or {}
    return cloud_config.get("sandboxId", device_id)


def _build_files_url(ip_address: str | None) -> str | None:
    """Build the files service URL from a Nevis VM IP."""
    if not ip_address:
        return None
    return f"http://{ip_address}:8080/files/"


async def _is_files_service_available(files_url: str | None) -> bool:
    """Probe the cloud device files service with a short timeout."""
    if not files_url:
        return False

    try:
        async with httpx.AsyncClient(
            timeout=FILES_SERVICE_TIMEOUT,
            follow_redirects=True,
        ) as client:
            response = await client.get(files_url)
            response.raise_for_status()
            return True
    except httpx.HTTPError:
        return False


@router.post("", response_model=CloudDeviceResponse)
async def create_cloud_device(
    request: Request,
    background_tasks: BackgroundTasks,
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

    try:
        # Get backend URL for executor to connect
        backend_url = _get_backend_url(request)

        # Resolve Git credentials for the device. A user without usable ones still
        # gets a working device; it just cannot push.
        git_tokens = await _get_current_user_git_tokens(current_user.user_name)

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
            user_jwt_token=_get_bearer_token(request),
            git_tokens=git_tokens,
            mail_email=body.mail_email or "",
            mail_password=body.mail_password or "",
        )
        background_tasks.add_task(
            cloud_device_ip_index_service.sync_device,
            current_user.id,
            result["device_id"],
        )

        return CloudDeviceResponse(**result)

    except HTTPException:
        raise

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


@router.post("/{device_id}/restart")
async def restart_cloud_device(
    device_id: str,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """Restart a cloud device owned by the current user.

    Args:
        device_id: Cloud device ID.

    Returns:
        Success message with the resolved sandbox ID.

    Raises:
        HTTPException 404: If device not found
        HTTPException 400: If the device cannot be restarted
        HTTPException 500: If Nevis API call fails
    """
    try:
        restart_result = await cloud_device_provider.restart_device(
            db=db,
            user_id=current_user.id,
            device_id=device_id,
        )
        background_tasks.add_task(
            cloud_device_ip_index_service.sync_device,
            current_user.id,
            restart_result["device_id"],
        )
        return {
            "message": "Restart command sent successfully",
            "device_id": restart_result["device_id"],
            "sandbox_id": restart_result["sandbox_id"],
        }

    except ValueError as e:
        message = str(e)
        if "not found" in message.lower():
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=message,
            )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=message,
        )

    except NevisClientError as e:
        logger.error(f"Nevis API error restarting cloud device: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to restart cloud device: {str(e)}",
        )

    except Exception as e:
        logger.exception(f"Unexpected error restarting cloud device: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to restart cloud device",
        )


@router.get("/{device_id}/status", response_model=NevisSandboxStatus)
async def get_cloud_device_nevis_status(
    device_id: str,
    user_id: int | None = None,
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
    device_status = await _get_accessible_cloud_device_status(
        device_id,
        db,
        current_user,
        user_id,
    )
    sandbox_id = _resolve_sandbox_id(device_id, device_status)
    resolved_user_id = _resolve_target_user_id(current_user, user_id)

    try:
        nevis_status = await cloud_device_provider.get_vm_status(sandbox_id)
        nevis_ip = normalize_nevis_ip(nevis_status.get("ip_address"))
        if nevis_ip:
            target = CloudDeviceIpTarget(
                user_id=resolved_user_id,
                device_name=device_status["device_id"],
                sandbox_id=sandbox_id,
            )
            try:
                if cloud_device_ip_index_service.persist_observation(
                    db, target, nevis_ip
                ):
                    db.commit()
            except Exception:
                db.rollback()
                logger.warning(
                    "Failed to persist Nevis IP observation: user_id=%s, "
                    "device_id=%s, sandbox_id=%s",
                    resolved_user_id,
                    device_status["device_id"],
                    sandbox_id,
                    exc_info=True,
                )
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


@router.get("/{device_id}/file-config", response_model=CloudDeviceFileConfigResponse)
async def get_cloud_device_file_config(
    device_id: str,
    user_id: int | None = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """Get file panel metadata for a cloud device."""
    if not cloud_device_provider.is_configured():
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Cloud device provider is not configured",
        )

    device_status = await _get_accessible_cloud_device_status(
        device_id,
        db,
        current_user,
        user_id,
    )
    sandbox_id = _resolve_sandbox_id(device_id, device_status)

    try:
        nevis_status = await cloud_device_provider.get_vm_status(sandbox_id)
    except NevisClientError as e:
        if e.status_code == 404:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Nevis sandbox '{device_id}' not found",
            )
        logger.error(f"Nevis API error getting file config: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to get cloud device file config: {str(e)}",
        )
    except Exception as e:
        logger.exception(f"Unexpected error getting cloud device file config: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to get cloud device file config",
        )

    ip_address = nevis_status.get("ip_address")
    files_url = _build_files_url(ip_address)
    available = await _is_files_service_available(files_url)

    return CloudDeviceFileConfigResponse(
        sandbox_id=nevis_status.get("sandbox_id", sandbox_id),
        ip_address=ip_address,
        files_url=files_url,
        available=available,
    )


@router.post("/{device_id}/metrics", response_model=CloudDeviceMetricsResponse)
async def get_cloud_device_metrics(
    device_id: str,
    user_id: int | None = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """Get CPU, memory, and disk usage metrics for a cloud device.

    Queries Nevis raw_query API for sandbox resource utilization.
    Does not require the device to be online.

    Args:
        device_id: Cloud device ID

    Returns:
        CloudDeviceMetricsResponse with cpu_usage, memory_usage, disk_usage
    """
    if not cloud_device_provider.is_configured():
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Cloud device provider is not configured",
        )

    device_status = await _get_accessible_cloud_device_status(
        device_id, db, current_user, user_id
    )
    sandbox_id = _resolve_sandbox_id(device_id, device_status)

    import time

    from wecode.service.nevis_client import nevis_client

    now = int(time.time())
    start = now - 300  # last 5 minutes

    results: dict[str, float | None] = {"cpu": None, "memory": None, "disk": None}

    async def _fetch_metric(key: str, query: str):
        try:
            resp = await nevis_client.query_metrics(
                sandbox_id=sandbox_id,
                query=query,
                start=start,
                end=now,
                step="1m",
            )
            data = resp.get("data", {}).get("data", {}).get("result", [])
            if data and len(data) > 0:
                values = data[0].get("values", [])
                if values:
                    results[key] = float(values[-1][1])
        except Exception as e:
            logger.warning(f"Failed to fetch {key} metric for {sandbox_id}: {e}")

    await asyncio.gather(
        _fetch_metric("cpu", METRIC_QUERIES["cpu"]),
        _fetch_metric("memory", METRIC_QUERIES["memory"]),
        _fetch_metric("disk", METRIC_QUERIES["disk"]),
    )

    return CloudDeviceMetricsResponse(
        cpu_usage=results["cpu"],
        memory_usage=results["memory"],
        disk_usage=results["disk"],
    )


@router.post("/{device_id}/metrics/history")
async def get_cloud_device_metrics_history(
    device_id: str,
    user_id: int | None = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """Get 1-hour metrics history for a cloud device.

    Returns time-series data points for CPU, memory, and disk usage.
    """
    if not cloud_device_provider.is_configured():
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Cloud device provider is not configured",
        )

    device_status = await _get_accessible_cloud_device_status(
        device_id, db, current_user, user_id
    )
    sandbox_id = _resolve_sandbox_id(device_id, device_status)

    import time

    from wecode.service.nevis_client import nevis_client

    now = int(time.time())
    start = now - 3600  # last 1 hour

    results: dict[str, list] = {"cpu": [], "memory": [], "disk": []}

    async def _fetch_series(key: str, query: str):
        try:
            resp = await nevis_client.query_metrics(
                sandbox_id=sandbox_id,
                query=query,
                start=start,
                end=now,
                step="1m",
            )
            data = resp.get("data", {}).get("data", {}).get("result", [])
            if data and len(data) > 0:
                values = data[0].get("values", [])
                results[key] = [[v[0], float(v[1])] for v in values]
        except Exception as e:
            logger.warning(f"Failed to fetch {key} history for {sandbox_id}: {e}")

    await asyncio.gather(
        _fetch_series("cpu", METRIC_QUERIES["cpu"]),
        _fetch_series("memory", METRIC_QUERIES["memory"]),
        _fetch_series("disk", METRIC_QUERIES["disk"]),
    )

    return results


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
        "can_create": True,
    }
