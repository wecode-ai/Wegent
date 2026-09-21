# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Internal admin lookup for a cloud device's Nevis IP address."""

import asyncio
import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.models.kind import Kind
from app.models.user import User
from app.schemas.device import DeviceType
from wecode.api.dependencies import get_admin_user_by_jwt_or_api_key
from wecode.service.cloud_device_ip_index import (
    CloudDeviceIpInvalidResponse,
    CloudDeviceIpLookupBusy,
    CloudDeviceIpLookupConflict,
    CloudDeviceIpTarget,
    cloud_device_ip_index_service,
    get_indexed_nevis_observation,
)
from wecode.service.nevis_client import NevisClientError

logger = logging.getLogger(__name__)
router = APIRouter()


class AdminCloudDeviceIpResponse(BaseModel):
    """Last observed Nevis IP for a cloud device."""

    device_id: str
    ip_address: Optional[str]
    observed_at: Optional[str]


def _find_cloud_device(db: Session, device_id: str) -> Kind:
    """Resolve one active cloud Device by its exact CRD name."""
    devices = (
        db.query(Kind)
        .filter(
            Kind.name == device_id,
            Kind.kind == "Device",
            Kind.namespace == "default",
            Kind.is_active.is_(True),
            Kind.json["spec"]["deviceType"].as_string() == DeviceType.CLOUD.value,
        )
        .limit(2)
        .all()
    )
    if not devices:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Cloud device not found")
    if len(devices) > 1:
        raise HTTPException(status.HTTP_409_CONFLICT, "Ambiguous cloud device ID")
    return devices[0]


@router.get("/{device_id}/ip", response_model=AdminCloudDeviceIpResponse)
async def get_cloud_device_ip(
    device_id: str,
    db: Session = Depends(get_db),
    _admin_user: User = Depends(get_admin_user_by_jwt_or_api_key),
) -> AdminCloudDeviceIpResponse:
    """Read the indexed IP, querying Nevis once only when it is missing."""
    device = _find_cloud_device(db, device_id)

    cloud_config = (device.json.get("spec") or {}).get("cloudConfig") or {}
    sandbox_id = cloud_config.get("sandboxId")
    if not isinstance(sandbox_id, str) or not sandbox_id.strip():
        raise HTTPException(status.HTTP_409_CONFLICT, "Cloud device has no sandbox")
    observation = get_indexed_nevis_observation(cloud_config)
    if observation.ip_address:
        return AdminCloudDeviceIpResponse(
            device_id=device_id,
            ip_address=observation.ip_address,
            observed_at=observation.observed_at,
        )

    target = CloudDeviceIpTarget(device.user_id, device.name, sandbox_id)
    db.rollback()
    try:
        observation = await cloud_device_ip_index_service.lookup_missing_ip(target)
    except CloudDeviceIpLookupBusy as exc:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "Cloud device IP lookup is in progress",
            headers={"Retry-After": "1"},
        ) from exc
    except CloudDeviceIpLookupConflict as exc:
        raise HTTPException(
            status.HTTP_409_CONFLICT, "Cloud device changed during IP lookup"
        ) from exc
    except asyncio.TimeoutError as exc:
        raise HTTPException(
            status.HTTP_504_GATEWAY_TIMEOUT, "Nevis IP lookup timed out"
        ) from exc
    except (NevisClientError, CloudDeviceIpInvalidResponse) as exc:
        logger.warning(
            "Nevis IP lookup failed: device_id=%s, error_type=%s",
            device_id,
            type(exc).__name__,
        )
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY, "Nevis IP lookup failed"
        ) from exc

    return AdminCloudDeviceIpResponse(
        device_id=device_id,
        ip_address=observation.ip_address,
        observed_at=observation.observed_at,
    )
