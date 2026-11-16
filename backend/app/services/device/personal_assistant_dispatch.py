"""Persist sanitized personal assistant declarations on their owning Device."""

from copy import deepcopy
from typing import Any

from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.schemas.personal_assistant_dispatch import PersonalAssistantDispatchFeatures
from app.services.device.identity import resolve_owned_device_alias


def persist_personal_assistant_dispatch(
    db: Session,
    *,
    user_id: int,
    device_id: str,
    advertisement: PersonalAssistantDispatchFeatures,
) -> bool:
    """Keep offline readiness without treating transport identity as user consent."""
    device = resolve_owned_device_alias(db, user_id=user_id, device_id=device_id)
    if device is None:
        return False
    device = (
        db.query(Kind)
        .filter_by(
            id=device.id,
            user_id=user_id,
            namespace="default",
            kind="Device",
            is_active=True,
        )
        .populate_existing()
        .with_for_update()
        .one_or_none()
    )
    if device is None:
        return False
    declaration: dict[str, Any] = advertisement.model_dump(
        mode="json", by_alias=True, exclude_none=True
    )
    declaration["roles"] = [
        role for role in declaration["roles"] if role["userId"] == user_id
    ]
    definition = deepcopy(device.json or {})
    spec = definition.setdefault("spec", {})
    if spec.get("personalAssistantDispatch") == declaration:
        return False
    spec["personalAssistantDispatch"] = declaration
    device.json = definition
    db.flush()
    return True
