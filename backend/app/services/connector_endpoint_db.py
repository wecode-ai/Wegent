# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Worker-owned database phases for connector HTTP endpoints."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.user import User
from app.schemas.connector import (
    ConnectorAppAdminResponse,
    ConnectorAppResponse,
    ConnectorAppUpdate,
    ConnectorAppWrite,
    ConnectorConnectionResponse,
)
from app.services.connector_apps import ConnectorApp, connector_app_service


@dataclass(frozen=True)
class ConnectorPrincipal:
    user_id: int
    user_name: str
    role: str


@dataclass(frozen=True)
class ConnectorUserAppPlan:
    app: ConnectorApp
    connection: ConnectorConnectionResponse


class ConnectorEndpointDB:
    """Own short connector sessions inside the bounded DB executor."""

    def __init__(
        self,
        session_factory: Callable[[], Session] | None = None,
    ) -> None:
        self._configured_session_factory = session_factory

    def _session_factory(self) -> Session:
        if self._configured_session_factory is not None:
            return self._configured_session_factory()
        from app.db.session import SessionLocal

        return SessionLocal()

    def resolve_runtime_principal(
        self,
        user_id: int,
        user_name: str,
    ) -> ConnectorPrincipal:
        with self._session_factory() as db:
            user = (
                db.query(User)
                .filter(
                    User.id == user_id,
                    User.user_name == user_name,
                    User.is_active,
                )
                .first()
            )
            if user is None:
                raise HTTPException(
                    status.HTTP_401_UNAUTHORIZED,
                    "Connector user unavailable",
                )
            return ConnectorPrincipal(
                user_id=user.id,
                user_name=user.user_name,
                role=user.role,
            )

    def list_user_apps(
        self,
        user_id: int,
        user_role: str,
    ) -> list[ConnectorAppResponse]:
        with self._session_factory() as db:
            return [
                connector_app_service.user_response(db, app, user_id)
                for app in connector_app_service.list_visible_apps(db, user_role)
            ]

    def validate_oauth_app(
        self,
        slug: str,
        user_role: str,
    ) -> None:
        with self._session_factory() as db:
            app = connector_app_service.get_app_by_slug(db, slug)
            visible_ids = {
                item.id
                for item in connector_app_service.list_visible_apps(db, user_role)
            }
            if app is None or app.id not in visible_ids:
                raise HTTPException(
                    status.HTTP_404_NOT_FOUND,
                    "Connector app not found",
                )
            if app.auth_type != "oauth2":
                raise HTTPException(
                    status.HTTP_422_UNPROCESSABLE_ENTITY,
                    "Connector app does not use OAuth",
                )

    def list_user_app_plans(
        self,
        user_id: int,
        user_role: str,
    ) -> tuple[ConnectorUserAppPlan, ...]:
        with self._session_factory() as db:
            return tuple(
                ConnectorUserAppPlan(
                    app=app,
                    connection=connector_app_service.user_response(
                        db,
                        app,
                        user_id,
                    ).connection,
                )
                for app in connector_app_service.list_visible_apps(db, user_role)
            )

    def list_admin_apps(self) -> list[ConnectorAppAdminResponse]:
        with self._session_factory() as db:
            return [
                connector_app_service.admin_response(db, app)
                for app in connector_app_service.list_all_apps(db)
            ]

    def create_admin_app(
        self,
        payload: ConnectorAppWrite,
        admin_id: int,
    ) -> ConnectorAppAdminResponse:
        with self._session_factory() as db:
            app = connector_app_service.create_app(db, payload, admin_id)
            return connector_app_service.admin_response(db, app)

    def get_admin_app(self, app_id: int) -> ConnectorAppAdminResponse:
        with self._session_factory() as db:
            app = connector_app_service.get_app(db, app_id)
            return connector_app_service.admin_response(db, app)

    def update_admin_app(
        self,
        app_id: int,
        payload: ConnectorAppUpdate,
    ) -> ConnectorAppAdminResponse:
        with self._session_factory() as db:
            app = connector_app_service.get_app(db, app_id)
            updated = connector_app_service.update_app(db, app, payload)
            return connector_app_service.admin_response(db, updated)

    def disable_admin_app(self, app_id: int) -> None:
        with self._session_factory() as db:
            app = connector_app_service.get_app(db, app_id)
            connector_app_service.disable_app(db, app)


connector_endpoint_db = ConnectorEndpointDB()
