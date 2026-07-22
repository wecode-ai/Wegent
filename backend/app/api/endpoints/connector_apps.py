# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""User-facing connector app catalog endpoints."""

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.security import get_current_user
from app.models.user import User
from app.schemas.connector import ConnectorAppResponse
from app.services.connector_apps import connector_app_service

router = APIRouter()


@router.get("", response_model=list[ConnectorAppResponse])
def list_connector_apps(
    db: Session = Depends(get_db), user: User = Depends(get_current_user)
) -> list[ConnectorAppResponse]:
    return [
        connector_app_service.user_response(db, app, user)
        for app in connector_app_service.list_visible_apps(db, user)
    ]
