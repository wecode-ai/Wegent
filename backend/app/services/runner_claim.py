"""Atomic Issue affinity updates shared by historical and routed claims."""

from typing import Any

from sqlalchemy import case, func, or_
from sqlalchemy.orm import Session

from app.models.delivery import LoopItem
from app.models.kind import Kind


def bind_issue_in_claim(
    db: Session, issue: LoopItem, execution: Any, device: Kind
) -> bool:
    """Both historical and routed claims share one durable affinity lock."""
    from app.models.loop_item_execution import LoopItemExecution
    from app.services.runner_routing import issue_binding

    scope = getattr(execution, "execution_scope", "")
    if (
        scope
        and db.query(LoopItemExecution.id)
        .filter(
            LoopItemExecution.execution_scope == scope,
            LoopItemExecution.status.in_(["claimed", "running", "cancel_requested"]),
        )
        .with_for_update()
        .first()
    ):
        return False
    from app.services.runner_recovery import original_session

    if original_session(execution):
        return True
    if not (issue.metadata_json or {}).get("runner_binding") or issue_binding(
        db, issue.id
    ) != str(device.id):
        metadata = case(
            (
                func.lower(func.json_type(LoopItem.metadata_json)) == "object",
                LoopItem.metadata_json,
            ),
            else_=func.json_object(),
        )
        saved = (issue.metadata_json or {}).get("runner_binding")
        # Retain the JSON CAS even on stores that do not implement row locks.
        expected_binding = (
            LoopItem.metadata_json["runner_binding"]["environment_id"].as_string()
            == saved["environment_id"]
            if saved
            else or_(
                func.json_extract(metadata, "$.runner_binding").is_(None),
                func.lower(
                    func.json_type(func.json_extract(metadata, "$.runner_binding"))
                )
                == "null",
            )
        )
        changed = (
            db.query(LoopItem)
            .filter(
                LoopItem.id == issue.id,
                LoopItem.version == issue.version,
                expected_binding,
            )
            .update(
                {
                    LoopItem.metadata_json: func.json_set(
                        metadata,
                        "$.runner_binding",
                        func.json_object("environment_id", str(device.id)),
                    ),
                },
                synchronize_session=False,
            )
        )
        if changed != 1:
            db.refresh(issue, with_for_update=True)
            return issue_binding(db, issue.id) == str(device.id)
        db.refresh(issue, with_for_update=True)
    return True
