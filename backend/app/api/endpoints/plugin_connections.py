"""Metadata-only management of account plugin connections.

Enrollment and runtime secret transfer require the native authenticated broker;
they are deliberately not exposed as general user or connector tool endpoints.
"""

from collections.abc import Iterator
from contextlib import contextmanager

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.security import get_current_user
from app.models.user import User
from app.schemas.plugin_account_auth import (
    PluginAccountConnectionResponse,
    PluginAuthAutomationPolicy,
    PluginConnectionRevision,
    PluginDeviceGrantWrite,
    PluginDisconnectRequest,
    PluginMigrationCreate,
    PluginMigrationResponse,
    PluginProviderRevocationConfirmation,
)
from app.services.plugin_account_connections import (
    PluginAccountAuthError,
)
from app.services.plugin_account_connections import (
    plugin_account_connection_service as connections,
)
from app.services.plugin_auth_automation import plugin_auth_automation
from app.services.plugin_auth_migrations import plugin_auth_migrations
from app.services.plugin_oauth_revocations import plugin_oauth_revocations


def no_store(response: Response) -> None:
    response.headers["Cache-Control"] = "no-store"


router = APIRouter(dependencies=[Depends(no_store)])


@contextmanager
def connection_transaction(db: Session) -> Iterator[None]:
    try:
        yield
        db.commit()
    except PluginAccountAuthError as exc:
        db.rollback()
        raise HTTPException(
            status_code=exc.status_code,
            detail=exc.code,
            headers={"Cache-Control": "no-store"},
        ) from None
    except Exception:
        db.rollback()
        raise


@router.get("", response_model=list[PluginAccountConnectionResponse])
def list_connections(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[PluginAccountConnectionResponse]:
    return connections.list_connections(db, user_id=user.id)


@router.get("/automation", response_model=PluginAuthAutomationPolicy)
def automation_policy(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    return {"enabled": plugin_auth_automation.enabled(db, user.id)}


@router.patch("/automation", response_model=PluginAuthAutomationPolicy)
def configure_automation(
    payload: PluginAuthAutomationPolicy,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    with connection_transaction(db):
        return plugin_auth_automation.configure(db, user.id, payload.enabled)


@router.post("/{connection_id}/devices", response_model=PluginAccountConnectionResponse)
def grant_device(
    connection_id: str,
    payload: PluginDeviceGrantWrite,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> PluginAccountConnectionResponse:
    with connection_transaction(db):
        return connections.grant_device(
            db,
            user_id=user.id,
            connection_id=connection_id,
            device_id=payload.device_id,
            expected_revision=payload.expected_revision,
        )


@router.delete(
    "/{connection_id}/devices/{device_id}",
    response_model=PluginAccountConnectionResponse,
)
def revoke_device(
    connection_id: str,
    device_id: str,
    payload: PluginConnectionRevision,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> PluginAccountConnectionResponse:
    with connection_transaction(db):
        return connections.revoke_device(
            db,
            user_id=user.id,
            connection_id=connection_id,
            device_id=device_id,
            expected_revision=payload.expected_revision,
        )


@router.delete("/{connection_id}", response_model=PluginAccountConnectionResponse)
def disconnect(
    connection_id: str,
    payload: PluginDisconnectRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> PluginAccountConnectionResponse:
    with connection_transaction(db):
        return connections.disconnect(
            db,
            user_id=user.id,
            connection_id=connection_id,
            expected_revision=payload.expected_revision,
            device_id=payload.device_id,
        )


@router.post(
    "/{connection_id}/retry-revocation", response_model=PluginAccountConnectionResponse
)
def retry_revocation(
    connection_id: str,
    payload: PluginDeviceGrantWrite,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> PluginAccountConnectionResponse:
    with connection_transaction(db):
        return plugin_oauth_revocations.retry(
            db,
            user_id=user.id,
            connection_id=connection_id,
            device_id=payload.device_id,
            expected_revision=payload.expected_revision,
        )


@router.post(
    "/{connection_id}/confirm-provider-revocation",
    response_model=PluginAccountConnectionResponse,
)
def confirm_provider_revocation(
    connection_id: str,
    payload: PluginProviderRevocationConfirmation,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> PluginAccountConnectionResponse:
    with connection_transaction(db):
        return plugin_oauth_revocations.confirm_external(
            db,
            user_id=user.id,
            connection_id=connection_id,
            expected_revision=payload.expected_revision,
        )


@router.post("/migrations", response_model=PluginMigrationResponse)
def create_migration(
    payload: PluginMigrationCreate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> PluginMigrationResponse:
    with connection_transaction(db):
        return plugin_auth_migrations.create(db, user_id=user.id, request=payload)
