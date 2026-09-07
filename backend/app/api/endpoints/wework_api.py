# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Personal API key access to Wework independent conversations."""

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Security
from fastapi.responses import StreamingResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session
from starlette.background import BackgroundTask

from app.api.dependencies import get_db
from app.core.auth_utils import verify_api_key
from app.core.config import settings
from app.core.rate_limit import get_limiter
from app.models.user import User
from app.schemas.wework_api import (
    WeworkDevice,
    WeworkDeviceList,
    WeworkResponseCreate,
    WeworkResponseObject,
)
from app.services.device_service import device_service
from app.services.wework_api import models, native, service
from shared.telemetry.decorators import trace_async

router = APIRouter(prefix="/v1/api/wework", tags=["wework-api"])
bearer = HTTPBearer(auto_error=False)
limiter = get_limiter()


def current_api_user(
    credentials: HTTPAuthorizationCredentials | None = Security(bearer),
    db: Session = Depends(get_db),
) -> User:
    user = verify_api_key(db, credentials.credentials) if credentials else None
    if user is None:
        raise HTTPException(
            401,
            "A valid personal Wegent API key is required",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return user


def _stream(response: service.LiveResponse) -> StreamingResponse:
    return StreamingResponse(
        service.stream_response(response),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        background=BackgroundTask(response.close),
    )


@router.get("/devices", response_model=WeworkDeviceList)
@trace_async("wework_api.devices", "wework.api")
async def list_devices(
    db: Session = Depends(get_db),
    user: User = Depends(current_api_user),
) -> WeworkDeviceList:
    devices = await device_service.get_all_devices(db, user.id)
    return WeworkDeviceList(data=[WeworkDevice(**device) for device in devices])


@router.get("/conversations")
async def list_conversations(
    limit: int = Query(20, ge=1, le=100),
    after: str | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(current_api_user),
):
    items = await native.conversations(db, user.id)
    if after:
        index = next(
            (index for index, item in enumerate(items) if item["id"] == after), None
        )
        if index is None:
            raise HTTPException(400, "Invalid conversation cursor")
        items = items[index + 1 :]
    page = [native.public_conversation(item) for item in items[:limit]]
    return {
        "object": "list",
        "data": page,
        "has_more": len(items) > limit,
        "first_id": page[0]["id"] if page else None,
        "last_id": page[-1]["id"] if page else None,
    }


@router.get("/conversations/{conversation_id}")
async def get_conversation(
    conversation_id: str,
    limit: int = Query(20, ge=1, le=200),
    before: str | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(current_api_user),
):
    return await native.conversation_detail(db, user.id, conversation_id, limit, before)


@router.post("/responses", response_model=WeworkResponseObject)
@limiter.limit(settings.RATE_LIMIT_CREATE_RESPONSE)
async def create_response(
    request: Request,
    body: WeworkResponseCreate,
    db: Session = Depends(get_db),
    user: User = Depends(current_api_user),
):
    response = await service.create_response(db, user, body)
    db.rollback()
    if body.stream:
        return _stream(response)
    if body.background:
        return response.snapshot
    return await service.wait_response(response)


@router.get("/responses/{response_id}", response_model=WeworkResponseObject)
async def get_response(
    response_id: str,
    stream: bool = False,
    starting_after: int | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(current_api_user),
):
    if starting_after is not None:
        raise HTTPException(
            400,
            "Event replay is not supported; read the current response and subscribe with stream=true",
        )
    response = await service.get_response(db, user.id, response_id, stream)
    db.rollback()
    return _stream(response) if isinstance(response, service.LiveResponse) else response


@router.post("/responses/{response_id}/cancel", response_model=WeworkResponseObject)
async def cancel_response(
    response_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(current_api_user),
):
    return await service.cancel_response(db, user.id, response_id)


@router.get("/models")
def list_models(db: Session = Depends(get_db), user: User = Depends(current_api_user)):
    return models.list_models(db, user)
