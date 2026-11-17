"""Human automation completes only through its current, complete Delivery."""

from copy import deepcopy
from unittest.mock import patch

import pytest
from fastapi import HTTPException

from app.core.config import settings
from app.models.cloud_project import CloudProject
from app.models.delivery import Delivery, ProjectAutomationRule, ProjectAutomationRun
from app.models.loop_item_execution import LoopItemExecution
from app.schemas.delivery import DeliveryCreate, DeliveryFinalize, LoopItemTaskBind
from app.services.delivery import delivery_service
from app.services.human_assistant_dispatch import current_dispatch
from app.services.loop_items.service import loop_item_service
from app.services.project_automation_execution import project_automation_execution
from app.services.project_automation_human import project_human_execution
from tests.api.test_deliveries_api import FakeDeliveryStorage
from tests.services.test_human_assistant_dispatch import _device
from tests.services.test_loop_item_assignment import _make_item, _make_project


@pytest.fixture
def human_automation(monkeypatch):
    monkeypatch.setattr(settings, "HUMAN_ASSIGNMENT_RECEIPTS_ENABLED", True)
    monkeypatch.setattr(settings, "HUMAN_AUTOMATION_RECEIPTS_ENABLED", True)
    monkeypatch.setattr(delivery_service, "storage", FakeDeliveryStorage())
    with (
        patch("app.core.async_utils.schedule_async_task"),
        patch("app.core.cache.cache_manager.mget_sync_or_raise", return_value={}),
    ):
        yield


async def _dispatch(db, user, *, stage=True):
    project = _make_project(db, user)
    item = _make_item(db, project, user)
    _device(db, user)
    rule = ProjectAutomationRule(
        id="human-rule",
        cloud_project_id=project.id,
        title="Design",
        description="Submit the design and interaction evidence.",
        created_by_user_id=user.id,
        metadata_json={},
    )
    metadata = (
        {
            "workflow_stage_input": {
                "target_stage": {
                    "id": "ux_spec",
                    "required_deliverables": [
                        {"id": "design", "value_type": "text"},
                        {"id": "states", "value_type": "text"},
                    ],
                }
            }
        }
        if stage
        else {}
    )
    run = ProjectAutomationRun(
        id="human-run",
        parent_id=rule.id,
        cloud_project_id=project.id,
        task_id=item.id,
        created_by_user_id=user.id,
        status="queued",
        source="event",
        metadata_json=metadata,
    )
    db.add_all([rule, run])
    db.commit()
    await project_automation_execution._dispatch_configured_target(
        db,
        owner=user,
        project=project,
        rule=rule,
        run=run,
        dispatch_target={"kind": "human", "id": str(user.id)},
    )
    dispatch = current_dispatch(db, item)
    execution = db.get(LoopItemExecution, dispatch["executionId"])
    identity = loop_item_service.response_values(db, item, user.id)[
        "human_task_binding"
    ]
    source = LoopItemTaskBind(
        deviceId="assistant-device",
        taskId="design-task",
        **identity,
        humanAssistantDispatchId=dispatch["dispatchId"],
    )
    binding = loop_item_service.bind_task(db, item.id, source, user.id)
    source.execution_context = {
        "human_automation": deepcopy(binding.metadata_json["human_automation"])
    }
    return item, run, execution, binding, source


@pytest.mark.asyncio
async def test_runtime_completion_waits_for_all_stage_deliverables(
    test_db, test_user, human_automation
):
    item, run, execution, binding, source = await _dispatch(test_db, test_user)
    assert run.status == "waiting_device"
    assert execution.status == "claimed"
    project_human_execution(test_db, execution=execution)
    assert run.status == "queued"
    execution.status = "running"
    execution.observed_state = "running"
    project_human_execution(test_db, execution=execution)
    assert run.status == "running"
    execution.observed_state = "waiting_user"
    project_human_execution(test_db, execution=execution)
    assert run.status == "waiting_user"
    execution.observed_state = "running"
    execution.status = "completed"
    project_human_execution(test_db, execution=execution)
    assert run.status == "blocked"
    assert (
        run.metadata_json["human_automation"]["reason_code"]
        == "required_delivery_pending"
    )
    test_db.commit()
    values = DeliveryCreate(
        title="Design evidence", markdown="Ready", source_task=source
    )
    delivery = delivery_service.create_delivery(test_db, item.id, test_user.id, values)
    repeated = delivery_service.create_delivery(test_db, item.id, test_user.id, values)
    assert repeated.id == delivery.id
    assert test_db.query(Delivery).filter_by(loop_item_id=item.id).count() == 1
    with pytest.raises(HTTPException, match="missing required deliverables"):
        delivery_service.finalize(
            test_db,
            delivery.id,
            test_user.id,
            DeliveryFinalize(
                fulfillments=[
                    {"requirement_id": "design", "kind": "text", "text": "Design"}
                ]
            ),
        )
    assert run.status == "blocked"
    delivered = delivery_service.finalize(
        test_db,
        delivery.id,
        test_user.id,
        DeliveryFinalize(
            fulfillments=[
                {"requirement_id": "design", "kind": "text", "text": "Design"},
                {"requirement_id": "states", "kind": "text", "text": "States"},
            ]
        ),
    )
    assert delivered.status == "delivered"
    assert run.status == "succeeded"
    assert run.metadata_json["human_automation"]["delivery_id"] == delivery.id
    assert run.completed_at is not None
    project_human_execution(test_db, execution=execution)
    assert run.status == "succeeded"
    assert binding.metadata_json["human_automation"]["workflow_stage_id"] == "ux_spec"


@pytest.mark.asyncio
async def test_non_workflow_delivery_and_replay_preserve_the_original_result(
    test_db, test_user, human_automation
):
    item, run, _, _, source = await _dispatch(test_db, test_user, stage=False)
    values = DeliveryCreate(title="Result", markdown="Done", source_task=source)
    delivery = delivery_service.create_delivery(test_db, item.id, test_user.id, values)
    delivery_service.finalize(
        test_db,
        delivery.id,
        test_user.id,
        DeliveryFinalize(
            fulfillments=[{"requirement_id": "summary", "kind": "text", "text": "Done"}]
        ),
    )
    repeated = delivery_service.create_delivery(test_db, item.id, test_user.id, values)
    assert repeated.id == delivery.id
    assert run.status == "succeeded"
    assert run.metadata_json["human_automation"]["workflow_stage_id"] is None


@pytest.mark.asyncio
async def test_old_delivery_cannot_complete_a_reused_runtime_binding(
    test_db, test_user, human_automation
):
    item, run, execution, binding, source = await _dispatch(test_db, test_user)
    delivery = delivery_service.create_delivery(
        test_db,
        item.id,
        test_user.id,
        DeliveryCreate(title="Old draft", markdown="Old", source_task=source),
    )
    changed = deepcopy(binding.metadata_json)
    changed["human_automation"]["idempotency_key"] = "another-run:assignment"
    binding.metadata_json = changed
    test_db.commit()
    with pytest.raises(HTTPException, match="earlier automation assignment"):
        delivery_service.finalize(
            test_db, delivery.id, test_user.id, DeliveryFinalize()
        )
    assert run.status != "succeeded"


@pytest.mark.asyncio
async def test_delayed_create_cannot_adopt_a_reused_runtime_bindings_new_run(
    test_db, test_user, human_automation
):
    item, old_run, _, old_binding, old_source = await _dispatch(test_db, test_user)
    new_run = ProjectAutomationRun(
        id="next-human-run",
        parent_id=old_run.parent_id,
        cloud_project_id=item.cloud_project_id,
        task_id=item.id,
        created_by_user_id=test_user.id,
        status="queued",
        source="event",
        metadata_json=deepcopy(old_run.metadata_json),
    )
    test_db.add(new_run)
    test_db.commit()
    await project_automation_execution._dispatch_configured_target(
        test_db,
        owner=test_user,
        project=test_db.get(CloudProject, item.cloud_project_id),
        rule=test_db.get(ProjectAutomationRule, old_run.parent_id),
        run=new_run,
        dispatch_target={"kind": "human", "id": str(test_user.id)},
    )
    dispatch = current_dispatch(test_db, item)
    identity = loop_item_service.response_values(test_db, item, test_user.id)[
        "human_task_binding"
    ]
    new_source = LoopItemTaskBind(
        deviceId=old_source.device_id,
        taskId=old_source.task_id,
        **identity,
        humanAssistantDispatchId=dispatch["dispatchId"],
    )
    binding = loop_item_service.bind_task(test_db, item.id, new_source, test_user.id)
    assert binding.id == old_binding.id
    assert old_source.assignment_id != binding.metadata_json["assignment_id"]

    with pytest.raises(HTTPException, match="automation identity") as error:
        delivery_service.create_delivery(
            test_db,
            item.id,
            test_user.id,
            DeliveryCreate(title="Late old result", source_task=old_source),
        )

    assert error.value.status_code == 409
    assert test_db.query(Delivery).filter_by(loop_item_id=item.id).count() == 0
    assert new_run.status != "succeeded"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "missing",
    [
        "assignment_id",
        "human_assignment_id",
        "automation_run_id",
        "idempotency_key",
        "execution_context",
    ],
)
async def test_automation_create_requires_immutable_source_identity(
    test_db, test_user, human_automation, missing
):
    item, run, _, _, source = await _dispatch(test_db, test_user)
    if missing in {"assignment_id", "human_assignment_id"}:
        setattr(source, missing, None)
    elif missing == "execution_context":
        source.execution_context = None
    else:
        source.execution_context["human_automation"].pop(missing)

    with pytest.raises(HTTPException, match="automation identity") as error:
        delivery_service.create_delivery(
            test_db,
            item.id,
            test_user.id,
            DeliveryCreate(title="Missing identity", source_task=source),
        )

    assert error.value.status_code == 409
    assert test_db.query(Delivery).filter_by(loop_item_id=item.id).count() == 0
    assert run.status != "succeeded"


@pytest.mark.asyncio
@pytest.mark.parametrize("state", ["failed", "cancelled"])
@pytest.mark.parametrize("observed", ["", "waiting_user", "requires_action"])
async def test_runtime_failure_and_cancellation_remain_distinct(
    test_db, test_user, human_automation, state, observed
):
    _, run, execution, _, _ = await _dispatch(test_db, test_user, stage=False)
    execution.status = state
    execution.observed_state = observed
    project_human_execution(test_db, execution=execution)
    assert run.status == state
    assert run.metadata_json["human_automation"]["non_workflow"] is True
    assert run.metadata_json["human_automation"]["workflow_stage_id"] is None
