"""Local plugin recovery records in the existing internal Kind store."""

import hashlib
from typing import Any

from fastapi import HTTPException
from sqlalchemy.orm import Query, Session

from app.models.kind import Kind
from app.services.device.plugin_sync_protocol import PLUGIN_SYNC_STATE_KIND

LOCAL_SYNC_NAMESPACE = "plugin-local-sync"


def operation_name(instance_id: str, operation_id: str) -> str:
    return hashlib.sha256(f"{instance_id}\0{operation_id}".encode()).hexdigest()


def local_operations(db: Session, user_id: int) -> Query[Kind]:
    return db.query(Kind).filter_by(
        user_id=user_id,
        kind=PLUGIN_SYNC_STATE_KIND,
        namespace=LOCAL_SYNC_NAMESPACE,
        is_active=True,
    )


def lookup_operation(
    db: Session, user_id: int, instance_id: str, operation_id: str
) -> Kind | None:
    rows = (
        local_operations(db, user_id)
        .filter_by(name=operation_name(instance_id, operation_id))
        .limit(2)
        .all()
    )
    if not rows:
        return None
    spec = rows[0].json.get("spec", {})
    if (
        len(rows) != 1
        or spec.get("instanceId") != instance_id
        or spec.get("operationId") != operation_id
    ):
        raise HTTPException(409, "plugin_write_conflict")
    return rows[0]


def save_operation(
    db: Session,
    *,
    user_id: int,
    instance_id: str,
    operation_id: str,
    request_hash: str,
    action: str,
    installed_id: int,
    document: dict[str, Any],
) -> Kind:
    """The caller holds the account write lease and commits the intent atomically."""
    name = operation_name(instance_id, operation_id)
    row = Kind(
        user_id=user_id,
        kind=PLUGIN_SYNC_STATE_KIND,
        namespace=LOCAL_SYNC_NAMESPACE,
        name=name,
        is_active=True,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": PLUGIN_SYNC_STATE_KIND,
            "metadata": {"name": name, "namespace": LOCAL_SYNC_NAMESPACE},
            "spec": {
                "instanceId": instance_id,
                "operationId": operation_id,
                "requestHash": request_hash,
                "action": action,
                "installedId": installed_id,
                "document": document,
            },
        },
    )
    db.add(row)
    return row
