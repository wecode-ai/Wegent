"""Workspace-owned machine identities with device-scoped, revocable credentials."""

import hashlib
import secrets
import uuid

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.user import User
from app.schemas.base_role import BaseRole
from app.services.workspaces.access import require_workspace_role
from app.services.workspaces.storage import (
    COLLABORATION_WORKSPACE_KIND,
    ensure_resource_grant,
    get_workspace_kind,
)

TOKEN_PREFIX = "wgr-"


def register_runner(db: Session, workspace_id: int, user_id: int, name: str) -> dict:
    require_workspace_role(db, workspace_id, user_id, BaseRole.Maintainer)
    db.query(Kind).filter_by(
        id=workspace_id, kind=COLLABORATION_WORKSPACE_KIND
    ).with_for_update().one()
    principal_name = f"workspace-runner-{workspace_id}"
    principal = db.query(User).filter_by(user_name=principal_name).first()
    if principal is not None and principal.auth_source != "runner":
        raise HTTPException(
            409, "Workspace machine identity conflicts with an existing account"
        )
    if principal is None:
        principal = User(
            user_name=principal_name,
            password_hash="!machine-identity",
            is_active=False,
            role="runner",
            auth_source="runner",
        )
        db.add(principal)
        db.flush()
    principal_id = principal.id
    device_name = f"space-runner-{uuid.uuid4().hex}"
    secret = secrets.token_urlsafe(32)
    device = Kind(
        kind="Device",
        name=device_name,
        namespace="default",
        user_id=principal_id,
        is_active=True,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Device",
            "metadata": {"name": device_name, "namespace": "default"},
            "spec": {
                "deviceType": "local",
                "deploymentLocation": "cloud",
                "displayName": name,
                "workspaceOwnerId": str(workspace_id),
                "runnerCredentialHash": hashlib.sha256(secret.encode()).hexdigest(),
            },
            "status": {"state": "Offline"},
        },
    )
    db.add(device)
    db.flush()
    ensure_resource_grant(
        db,
        workspace_id=workspace_id,
        resource_type="Device",
        resource_id=device.id,
        added_by_user_id=user_id,
        role=BaseRole.Owner,
    )
    db.commit()
    return {
        "environment_id": str(device.id),
        "device_id": device_name,
        "token": f"{TOKEN_PREFIX}{device.id}.{secret}",
    }


def verify_runner_token(db: Session, token: str) -> Kind | None:
    if not token.startswith(TOKEN_PREFIX):
        return None
    record_id, separator, secret = token[len(TOKEN_PREFIX) :].partition(".")
    if not separator or not record_id.isdecimal() or not secret:
        return None
    device = (
        db.query(Kind)
        .filter_by(
            id=int(record_id), kind="Device", namespace="default", is_active=True
        )
        .first()
    )
    if device is None:
        return None
    spec = (device.json or {}).get("spec") or {}
    expected = spec.get("runnerCredentialHash")
    owner = spec.get("workspaceOwnerId")
    if not expected or not owner or get_workspace_kind(db, int(owner)) is None:
        return None
    digest = hashlib.sha256(secret.encode()).hexdigest()
    return device if secrets.compare_digest(expected, digest) else None


def revoke_runner(
    db: Session,
    workspace_id: int,
    user_id: int,
    environment_id: int,
    *,
    commit: bool = True,
) -> Kind:
    require_workspace_role(db, workspace_id, user_id, BaseRole.Maintainer)
    device = (
        db.query(Kind)
        .filter_by(id=environment_id, kind="Device", namespace="default")
        .first()
    )
    spec = dict((device.json or {}).get("spec") or {}) if device else {}
    if spec.get("workspaceOwnerId") != str(workspace_id):
        raise HTTPException(404, "Workspace runner not found")
    spec.pop("runnerCredentialHash", None)
    device.json = {**device.json, "spec": spec}
    device.is_active = False
    if commit:
        from app.services.collaboration_revocation import (
            revoke_unauthorized_project_work,
        )
        from app.services.loop_item_executions.cancellation import (
            request_execution_cancellations,
        )
        from app.services.workspaces.storage import project_ids_for_workspace

        db.flush()
        pending = [
            run
            for pid in project_ids_for_workspace(db, workspace_id)
            for run in revoke_unauthorized_project_work(db, pid)
        ]
        db.commit()
        request_execution_cancellations(pending)
    else:
        db.flush()
    return device


def verify_runner_connection(token: str) -> tuple[int, str] | None:
    from app.db.session import get_db_session

    with get_db_session() as db:
        device = verify_runner_token(db, token)
        return (device.user_id, device.name) if device else None
