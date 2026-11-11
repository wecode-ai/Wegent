"""Request progress while a synchronous Issue transaction waits for a lock."""

import asyncio
from threading import Event
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException

from app.api.endpoints import deliveries
from app.models.delivery import ProjectAutomationRule, ProjectAutomationRun
from app.schemas.delivery import LoopItemCreate
from tests.api.test_deliveries_api import delivery_project as delivery_project


@pytest.mark.asyncio
async def test_issue_lock_wait_does_not_block_other_request_cleanup(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    loop = asyncio.get_running_loop()
    transaction_released = Event()
    project = SimpleNamespace(id=1, task_provider="internal", metadata_json={})
    user = SimpleNamespace(id=2)
    db = MagicMock()
    values = LoopItemCreate(title="Concurrent Issue")
    failure = HTTPException(status_code=422, detail="Assignee changed")
    monkeypatch.setattr(deliveries.cloud_project_service, "get", lambda *_: project)
    monkeypatch.setattr(
        deliveries, "_selected_event_automation_id", lambda *_args, **_kwargs: None
    )

    def create(*args: object) -> None:
        assert args == (db, project, user, values)
        # Another request releases its transaction on the same event loop.
        loop.call_soon_threadsafe(transaction_released.set)
        assert transaction_released.wait(
            timeout=2
        ), "Issue lock wait blocked request cleanup"
        raise failure

    monkeypatch.setattr(deliveries.loop_item_provider_router, "create", create)
    with pytest.raises(HTTPException) as rejected:
        await deliveries.create_loop_item(1, values, db, user)
    assert rejected.value is failure


def test_creation_dispatches_automation_without_scanning_the_global_queue(
    test_client, test_db, test_user, test_token, delivery_project, monkeypatch
):
    rule = ProjectAutomationRule(
        cloud_project_id=delivery_project.id,
        title="Assign new Issue",
        status="enabled",
        created_by_user_id=test_user.id,
        metadata_json={
            "trigger_type": "event",
            "event_type": "task.created",
            "event_config": {"execution_target": "existing_issue"},
            "dispatch_target": {"kind": "human", "id": str(test_user.id)},
        },
    )
    test_db.add(rule)
    test_db.commit()
    scan = MagicMock(side_effect=AssertionError("Creation must not scan other work"))
    monkeypatch.setattr("app.tasks.robot_queue_tasks._prepare_queue_targets", scan)

    response = test_client.post(
        f"/api/v1/cloud-projects/{delivery_project.id}/loop-items",
        headers={"Authorization": f"Bearer {test_token}"},
        json={"title": "Independent creation"},
    )

    assert response.status_code == 201
    run = test_db.query(ProjectAutomationRun).filter_by(parent_id=str(rule.id)).one()
    assert run.task_id == response.json()["id"]
    assert run.status == "succeeded"
    scan.assert_not_called()
