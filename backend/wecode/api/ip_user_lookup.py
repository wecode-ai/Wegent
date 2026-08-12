# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Internal admin endpoint for resolving IP addresses to users."""

from fastapi import APIRouter, Depends, Query
from pydantic import IPvAnyAddress
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.models.user import User
from wecode.api.dependencies import get_admin_user_by_jwt_or_api_key
from wecode.schemas.ip_user_lookup import IpUserLookupResponse
from wecode.service.ip_user_lookup import ip_user_lookup_service

router = APIRouter()


@router.get("/by-ip", response_model=IpUserLookupResponse)
async def get_users_by_ip(
    ip: IPvAnyAddress = Query(
        ...,
        description="Pod or cloud-device IP address",
    ),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user_by_jwt_or_api_key),
) -> IpUserLookupResponse:
    """Resolve an IP address to cloud-device and Kubernetes Pod owners."""
    return await ip_user_lookup_service.lookup(db, str(ip))
