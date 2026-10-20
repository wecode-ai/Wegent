"""Delivery and automation retain one owner's session across device aliases."""

import json
from datetime import datetime

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.delivery import LoopItem, LoopItemTaskBinding
from app.models.kind import Kind
from app.models.loop_item_execution import LoopItemExecution
from app.models.user import User
from app.schemas.delivery import LoopItemTaskBind
from app.services.delivery import delivery_service
from app.services.loop_items.service import loop_item_service
from app.services.project_automation_execution import ProjectAutomationProcessor
from tests.services.test_loop_item_task_binding_identity import issue_device


def bind_session(
    db: Session, issue: LoopItem, user: User, device_id: str
) -> LoopItemTaskBinding:
    return loop_item_service.bind_task(
        db,
        issue.id,
        LoopItemTaskBind(deviceId=device_id, taskId="artifact-task"),
        user.id,
    )


@pytest.mark.parametrize("reverse_aliases", [False, True])
def test_delivery_resolves_the_bound_session_from_either_device_alias(
    test_db: Session,
    test_user: User,
    issue_device: tuple[LoopItem, Kind],
    reverse_aliases: bool,
) -> None:
    issue, device = issue_device
    aliases = ["electron-device", f"app-record-{device.id}"]
    if reverse_aliases:
        aliases.reverse()
    binding = bind_session(test_db, issue, test_user, aliases[0])

    resolved, snapshot = delivery_service._resolve_source_task(
        test_db,
        issue,
        LoopItemTaskBind(deviceId=aliases[1], taskId=binding.task_id),
        test_user.id,
    )

    assert resolved.id == binding.id
    assert snapshot["deviceId"] == aliases[0]
    assert snapshot["taskId"] == binding.task_id


@pytest.mark.parametrize("removed", ["unlinked_at", "deleted_at"])
def test_delivery_rejects_removed_session_bindings(
    test_db: Session,
    test_user: User,
    issue_device: tuple[LoopItem, Kind],
    removed: str,
) -> None:
    issue, _ = issue_device
    binding = bind_session(test_db, issue, test_user, "electron-device")
    setattr(binding, removed, datetime(2026, 10, 16))
    test_db.commit()

    with pytest.raises(HTTPException) as error:
        delivery_service._resolve_source_task(
            test_db,
            issue,
            LoopItemTaskBind(deviceId="electron-device", taskId=binding.task_id),
            test_user.id,
        )

    assert error.value.status_code == 409
    with pytest.raises(HTTPException) as finalize_error:
        delivery_service._require_active_task_binding(test_db, issue.id, binding.id)

    assert finalize_error.value.status_code == 409


def test_automation_preserves_the_bound_owners_latest_session_model(
    test_db: Session,
    test_user: User,
    test_admin_user: User,
    issue_device: tuple[LoopItem, Kind],
) -> None:
    issue, device = issue_device
    binding = bind_session(test_db, issue, test_user, "electron-device")

    def execution(owner_id: int, model: str) -> LoopItemExecution:
        return LoopItemExecution(
            loop_item_id=issue.id,
            cloud_project_id=str(issue.cloud_project_id),
            executor_owner_user_id=owner_id,
            assigner_user_id=owner_id,
            status="completed",
            execution_device_id=f"app-record-{device.id}",
            runtime_device_id=f"app-record-{device.id}",
            runtime_task_id=binding.task_id,
            execution_payload=json.dumps(
                {
                    "schema_version": 2,
                    "runtime_selection": {
                        "model": model,
                        "model_type": "user",
                        "model_options": {"reasoning_effort": "high"},
                    },
                }
            ),
        )

    test_db.add(execution(test_user.id, "bound-session-model"))
    test_db.flush()
    test_db.add(execution(test_admin_user.id, "other-owners-model"))
    test_db.commit()

    selection = ProjectAutomationProcessor._bound_runtime_model_selection(
        test_db, binding
    )

    assert selection is not None
    assert selection.model_name == "bound-session-model"
    assert selection.model_type == "user"
    assert selection.options == {"reasoning_effort": "high"}
