# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Human automation dispatch must wait for execution and preserve its stage."""

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from app.services.loop_items.service import loop_item_service
from app.services.project_automation_execution import (
    ProjectAutomationExecution,
    settings,
)


async def _dispatch_human_target(
    monkeypatch: pytest.MonkeyPatch,
    *,
    run_metadata: dict | None = None,
    receipts_enabled: bool = True,
) -> tuple[SimpleNamespace, MagicMock]:
    from app.services import project_automation_human

    monkeypatch.setattr(settings, "HUMAN_AUTOMATION_RECEIPTS_ENABLED", receipts_enabled)
    db = MagicMock()
    db.get.return_value = SimpleNamespace(id="issue-1", version=3)
    assignment = MagicMock()
    monkeypatch.setattr(loop_item_service, "assign", assignment)
    initialize = MagicMock()
    monkeypatch.setattr(
        project_automation_human, "initialize_human_automation", initialize
    )
    rule = SimpleNamespace(
        id="rule-1",
        title="Prepare the design",
        description="Submit the required stage deliverables",
        cloud_project_id="1",
        created_by_user_id=7,
        metadata_json={},
    )
    run = SimpleNamespace(
        id="run-1",
        task_id="issue-1",
        source="event",
        status="queued",
        version=1,
        completed_at=None,
        metadata_json=run_metadata or {},
    )

    await ProjectAutomationExecution()._dispatch_configured_target(
        db,
        owner=SimpleNamespace(id=7),
        project=SimpleNamespace(id=1),
        rule=rule,
        run=run,
        dispatch_target={"kind": "human", "id": "8"},
    )

    assignment.assert_called_once()
    assert assignment.call_args.kwargs["values"].assignee_id == "8"
    if receipts_enabled:
        initialize.assert_called_once_with(
            db,
            run=run,
            context=assignment.call_args.kwargs["automation_context"],
            target_user_id=8,
        )
    else:
        initialize.assert_not_called()
    return run, assignment


@pytest.mark.asyncio
async def test_human_assignment_without_runtime_receipt_remains_queued(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    run, _ = await _dispatch_human_target(monkeypatch)

    assert run.status in {"queued", "waiting"}


@pytest.mark.asyncio
async def test_human_assignment_without_delivery_has_no_completion_timestamp(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    run, _ = await _dispatch_human_target(monkeypatch)

    assert run.completed_at is None


@pytest.mark.asyncio
async def test_human_assignment_preserves_the_persisted_workflow_stage(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _, assignment = await _dispatch_human_target(
        monkeypatch,
        run_metadata={
            "workflow_stage_input": {
                "target_stage": {
                    "id": "ux_spec",
                    "required_deliverables": [
                        {"id": "ux_spec_file", "value_type": "file"}
                    ],
                }
            }
        },
    )

    assert assignment.call_args.kwargs["values"].workflow_step == "ux_spec"
    assert assignment.call_args.kwargs["automation_context"][
        "workflow_stage_input"
    ] == {
        "target_stage": {
            "id": "ux_spec",
            "required_deliverables": [{"id": "ux_spec_file", "value_type": "file"}],
        }
    }


@pytest.mark.asyncio
async def test_non_workflow_human_assignment_does_not_fabricate_a_stage(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _, assignment = await _dispatch_human_target(monkeypatch)

    assert assignment.call_args.kwargs["values"].workflow_step is None
    assert (
        "workflow_stage_input" not in assignment.call_args.kwargs["automation_context"]
    )


@pytest.mark.asyncio
async def test_disabled_receipts_preserve_the_legacy_assignment_projection(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    run, _ = await _dispatch_human_target(monkeypatch, receipts_enabled=False)

    assert run.status == "succeeded"
    assert run.completed_at is not None


@pytest.mark.asyncio
async def test_workflow_dispatch_requires_its_persisted_stage_identity(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with pytest.raises(RuntimeError, match="has no target stage"):
        await _dispatch_human_target(
            monkeypatch,
            run_metadata={"workflow_stage_input": {"target_stage": {}}},
        )
