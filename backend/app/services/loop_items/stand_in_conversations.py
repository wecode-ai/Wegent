"""Serialize stand-in conversation ownership independently of wakeup identity."""

from fastapi import HTTPException
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.models.delivery import LoopItem, LoopItemTaskBinding, loop_datetime_is_unset
from app.schemas.delivery import LoopItemTaskBind
from app.services.device.identity import resolve_owned_device_alias, same_owned_device
from shared.telemetry.decorators import trace_sync


@trace_sync("stand_in.reserve_issue_conversation", tracer_name="backend.loop_items")
def require_conversation_reservation(
    db: Session, *, item: LoopItem, values: LoopItemTaskBind, user_id: int
) -> None:
    if (
        resolve_owned_device_alias(db, user_id=user_id, device_id=values.device_id)
        is None
    ):
        raise HTTPException(
            403, "Stand-in conversations require an active owned device"
        )
    db.query(LoopItem).filter_by(id=item.id).populate_existing().with_for_update().one()
    bindings = (
        db.query(LoopItemTaskBinding)
        .filter(
            LoopItemTaskBinding.cloud_project_id == item.cloud_project_id,
            LoopItemTaskBinding.loop_item_id == item.id,
            LoopItemTaskBinding.task_user_id == user_id,
            loop_datetime_is_unset(LoopItemTaskBinding.deleted_at),
            loop_datetime_is_unset(LoopItemTaskBinding.unlinked_at),
            or_(
                LoopItemTaskBinding.metadata_json[
                    "stand_in_conversation_id"
                ].as_string()
                == values.stand_in_conversation_id,
                LoopItemTaskBinding.task_id == values.stand_in_conversation_id,
            ),
        )
        .populate_existing()
        .with_for_update()
        .all()
    )
    for binding in bindings:
        if binding.task_id != values.task_id or not same_owned_device(
            db,
            user_id=user_id,
            left_device_id=values.device_id,
            right_device_id=binding.device_id,
        ):
            raise HTTPException(
                409, "This stand-in Issue conversation is already reserved"
            )
