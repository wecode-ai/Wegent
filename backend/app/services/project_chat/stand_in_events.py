"""Persist Issue wakeups independently of human notification preferences."""

import hashlib
import json

from sqlalchemy.dialects.mysql import insert as mysql_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session

from app.models.delivery import LoopNode, StandInIssueInbox
from app.services.device.identity import lock_device_owner
from shared.telemetry.decorators import trace_sync


@trace_sync("stand_in.issue_wakeup", tracer_name="backend.project_chat")
def enqueue_issue_wakeup(db: Session, *, user_id: int, payload: dict) -> None:
    """Use the shared node table and its parent/type/sequence index."""
    event_id = hashlib.sha256(
        f"stand-in:{user_id}:{json.dumps(payload, sort_keys=True)}".encode()
    ).hexdigest()
    # All writers lock the owning Issue before recipient inboxes.
    # Provider-owned Issues may have no local index row at all.
    if db.get(LoopNode, payload["itemId"]) is not None:
        db.query(LoopNode).filter_by(id=payload["itemId"]).with_for_update().one()
    lock_device_owner(db, user_id)
    inbox_id = f"stand-in-inbox:{user_id}"
    _insert_once(
        db,
        {
            "id": inbox_id,
            "resource_type": "stand_in_issue_inbox",
            "user_id": user_id,
            "next_item_number": 1,
        },
    )
    # A locking/current read observes the preceding writer even under MySQL RR.
    inbox = (
        db.query(StandInIssueInbox)
        .filter_by(id=inbox_id)
        .populate_existing()
        .with_for_update()
        .one()
    )
    sequence = inbox.next_item_number
    inbox.next_item_number = sequence + 1
    _insert_once(
        db,
        {
            "id": event_id,
            "resource_type": "stand_in_issue_event",
            "parent_id": inbox_id,
            "user_id": user_id,
            "sort_order": sequence,
            "metadata": payload,
        },
    )


def _insert_once(db: Session, values: dict) -> None:
    table = LoopNode.__table__
    if db.get_bind().dialect.name == "sqlite":
        statement = (
            sqlite_insert(table)
            .values(**values)
            .on_conflict_do_nothing(index_elements=["id"])
        )
    else:
        statement = (
            mysql_insert(table)
            .values(**values)
            .on_duplicate_key_update(id=values["id"])
        )
    db.execute(statement)
