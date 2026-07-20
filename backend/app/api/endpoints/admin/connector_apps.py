# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Administrator endpoints for the connector app catalog."""

from fastapi import APIRouter, Depends, Response, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.security import get_admin_user
from app.models.connector import ConnectorApp
from app.models.user import User
from app.schemas.connector import (
    ConnectorAppAdminResponse,
    ConnectorAppUpdate,
    ConnectorAppWrite,
)
from app.services.connector_apps import connector_app_service

router = APIRouter(prefix="/connector-apps")


@router.get("", response_model=list[ConnectorAppAdminResponse])
def list_connector_apps(
    db: Session = Depends(get_db), _: User = Depends(get_admin_user)
) -> list[ConnectorAppAdminResponse]:
    apps = db.query(ConnectorApp).order_by(ConnectorApp.name, ConnectorApp.id).all()
    return [connector_app_service.admin_response(db, app) for app in apps]


@router.post("", response_model=ConnectorAppAdminResponse, status_code=201)
def create_connector_app(
    payload: ConnectorAppWrite,
    db: Session = Depends(get_db),
    admin: User = Depends(get_admin_user),
) -> ConnectorAppAdminResponse:
    app = connector_app_service.create_app(db, payload, admin)
    return connector_app_service.admin_response(db, app)


@router.get("/{app_id}", response_model=ConnectorAppAdminResponse)
def get_connector_app(
    app_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(get_admin_user),
) -> ConnectorAppAdminResponse:
    return connector_app_service.admin_response(
        db, connector_app_service.get_app(db, app_id)
    )


@router.patch("/{app_id}", response_model=ConnectorAppAdminResponse)
def update_connector_app(
    app_id: int,
    payload: ConnectorAppUpdate,
    db: Session = Depends(get_db),
    _: User = Depends(get_admin_user),
) -> ConnectorAppAdminResponse:
    app = connector_app_service.update_app(
        db, connector_app_service.get_app(db, app_id), payload
    )
    return connector_app_service.admin_response(db, app)


@router.delete("/{app_id}", status_code=status.HTTP_204_NO_CONTENT)
def disable_connector_app(
    app_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(get_admin_user),
) -> Response:
    app = connector_app_service.get_app(db, app_id)
    connector_app_service.disable_app(db, app)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
