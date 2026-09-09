import json
import uuid
from datetime import datetime

from sqlalchemy.orm import Session

from app.models.delivery import CloudProject, Delivery, LoopItem, LoopItemTaskBinding
from app.services.workflow_deliverables import (
    fulfilled_requirement_ids,
    missing_requirement_ids,
)
from app.services.workflow_delivery_catalog import workflow_delivery_catalog
from app.services.workflow_stage_launch import (
    resolve_workflow_stage_launch,
    workflow_stage_launch_instruction,
)


def _project(test_db: Session, test_user) -> CloudProject:
    public_id = str(uuid.uuid4())
    project = CloudProject(
        public_id=public_id,
        project_key="DELIVERY",
        name="Delivery project",
        description="",
        created_by_user_id=test_user.id,
        storage_prefix=f"projects/{public_id}",
    )
    test_db.add(project)
    test_db.flush()
    return project


def _item(
    test_db: Session,
    test_user,
    project: CloudProject,
    node_id: str = "stage-1",
) -> LoopItem:
    item = LoopItem(
        cloud_project_id=project.id,
        title="Workflow delivery",
        description="",
        status="in_progress",
        created_by_user_id=test_user.id,
        metadata_json={
            "workflow": {
                "version": 1,
                "definition_version": 1,
                "stage_mode": "dag",
                "advancement_policy": "manual",
                "nodes": [
                    {
                        "id": node_id,
                        "name": "Stage",
                        "execution_mode": "robot",
                        "depends_on": [],
                        "required": True,
                        "workspace_policy": "none",
                        "status": "awaiting_deliverables",
                        "delivery_ids": [],
                        "required_deliverables": [
                            {
                                "id": "req-1",
                                "name": "MR",
                                "value_type": "pull_request",
                            }
                        ],
                    }
                ],
            }
        },
    )
    test_db.add(item)
    test_db.flush()
    return item


def _delivered_delivery(
    test_db: Session,
    test_user,
    item: LoopItem,
    binding: LoopItemTaskBinding,
    *,
    requirement_id: str,
) -> Delivery:
    delivery = Delivery(
        cloud_project_id=item.cloud_project_id,
        loop_item_id=item.id,
        status="delivered",
        created_by_user_id=test_user.id,
        source_task_binding_id=str(binding.id),
        source_task_snapshot={"taskId": binding.task_id},
        metadata_json={
            "fulfillments": [
                {
                    "requirement_id": requirement_id,
                    "kind": "pull_request",
                    "provider": "gitlab",
                    "url": "https://gitlab.example/repo/-/merge_requests/1",
                    "number": 1,
                    "state": "draft",
                    "head_branch": "feat/x",
                    "base_branch": "main",
                    "head_commit": "abc1234",
                }
            ]
        },
    )
    test_db.add(delivery)
    test_db.flush()
    return delivery


def _binding(
    test_db: Session,
    test_user,
    item: LoopItem,
    *,
    node_id: str,
) -> LoopItemTaskBinding:
    binding = LoopItemTaskBinding(
        cloud_project_id=item.cloud_project_id,
        loop_item_id=item.id,
        task_user_id=test_user.id,
        device_id=f"device-{uuid.uuid4().hex[:8]}",
        task_id=f"task-{uuid.uuid4().hex[:8]}",
        linked_by_user_id=test_user.id,
        metadata_json={"workflow_node_id": node_id},
    )
    test_db.add(binding)
    test_db.flush()
    return binding


def test_missing_requirement_is_derived_from_stage_delivery_without_node_link(
    test_db: Session,
    test_user,
) -> None:
    project = _project(test_db, test_user)
    item = _item(test_db, test_user, project)
    binding = _binding(test_db, test_user, item, node_id="stage-1")
    _delivered_delivery(
        test_db,
        test_user,
        item,
        binding,
        requirement_id="req-1",
    )
    test_db.commit()
    test_db.refresh(item)
    node = item.metadata_json["workflow"]["nodes"][0]

    assert missing_requirement_ids(db=test_db, node=node) == ["req-1"]
    assert missing_requirement_ids(db=test_db, node=node, loop_item_id=item.id) == []
    assert fulfilled_requirement_ids(db=test_db, node=node, loop_item_id=item.id) == {
        "req-1"
    }


def test_stage_delivery_does_not_cover_another_stage_requirement(
    test_db: Session,
    test_user,
) -> None:
    project = _project(test_db, test_user)
    item = _item(test_db, test_user, project, node_id="stage-1")
    other_binding = _binding(test_db, test_user, item, node_id="stage-2")
    _delivered_delivery(
        test_db,
        test_user,
        item,
        other_binding,
        requirement_id="req-1",
    )
    test_db.commit()
    test_db.refresh(item)
    node = item.metadata_json["workflow"]["nodes"][0]

    assert missing_requirement_ids(db=test_db, node=node, loop_item_id=item.id) == [
        "req-1"
    ]


def test_node_link_and_stage_derivation_are_combined(
    test_db: Session,
    test_user,
) -> None:
    project = _project(test_db, test_user)
    item = _item(test_db, test_user, project, node_id="stage-1")
    binding = _binding(test_db, test_user, item, node_id="stage-1")
    _delivered_delivery(
        test_db,
        test_user,
        item,
        binding,
        requirement_id="req-1",
    )
    test_db.commit()
    test_db.refresh(item)
    node = item.metadata_json["workflow"]["nodes"][0]
    node["delivery_ids"] = [binding.id]

    assert missing_requirement_ids(db=test_db, node=node, loop_item_id=item.id) == []


def test_launch_catalog_tracks_partial_replacements_without_delivery_content(
    test_db: Session, test_user
) -> None:
    project = _project(test_db, test_user)
    item = _item(test_db, test_user, project)
    binding = _binding(test_db, test_user, item, node_id="stage-1")
    old = _delivered_delivery(test_db, test_user, item, binding, requirement_id="req-1")
    old.delivered_at = datetime(2026, 9, 9, 10)
    old.metadata_json = {
        "fulfillments": [
            {"requirement_id": "req-1", "kind": "text", "text": "BODY" * 100_000},
            {"requirement_id": "req-2", "kind": "url", "url": "PRIVATE_URL"},
        ],
        "report": "PRIVATE_REPORT",
    }
    new = _delivered_delivery(test_db, test_user, item, binding, requirement_id="req-1")
    new.delivered_at = datetime(2026, 9, 9, 11)
    # Unlinking a task does not erase the provenance of its published output.
    binding.unlinked_at = datetime(2026, 9, 9, 12)
    test_db.flush()

    launch = resolve_workflow_stage_launch(test_db, item=item, target_node_id="stage-1")
    entries = {
        (entry["delivery_id"], entry["requirement_id"]): entry
        for entry in launch["upstream_deliverables"]
    }
    assert len(entries) == 3
    assert entries[(old.id, "req-1")]["superseded_by_delivery_id"] == new.id
    assert entries[(old.id, "req-2")]["superseded_by_delivery_id"] is None
    current = entries[(new.id, "req-1")]
    assert current == {
        "delivery_id": new.id,
        "requirement_id": "req-1",
        "name": "MR",
        "type": "pull_request",
        "stage_id": "stage-1",
        "stage_name": "Stage",
        "submitted_at": "2026-09-09T11:00:00",
        "superseded_by_delivery_id": None,
    }
    prompt = workflow_stage_launch_instruction(launch)
    assert old.id in prompt and new.id in prompt
    serialized = json.dumps(launch) + prompt
    assert len(serialized.encode()) < 16_384
    for private_content in ("BODY", "PRIVATE_URL", "PRIVATE_REPORT"):
        assert private_content not in serialized


def test_catalog_is_issue_scoped_and_does_not_replace_other_stage_results(
    test_db: Session, test_user
) -> None:
    project = _project(test_db, test_user)
    item = _item(test_db, test_user, project)
    other = _item(test_db, test_user, project)
    binding = _binding(test_db, test_user, item, node_id="stage-1")
    second_binding = _binding(test_db, test_user, item, node_id="stage-2")
    first = _delivered_delivery(
        test_db, test_user, item, binding, requirement_id="req-1"
    )
    second = _delivered_delivery(
        test_db, test_user, item, second_binding, requirement_id="req-1"
    )
    foreign = _delivered_delivery(
        test_db, test_user, other, binding, requirement_id="req-1"
    )
    deleted = _delivered_delivery(
        test_db, test_user, item, binding, requirement_id="req-1"
    )
    deleted.deleted_at = datetime(2026, 9, 10)
    draft = _delivered_delivery(
        test_db, test_user, item, binding, requirement_id="req-1"
    )
    draft.status = "draft"
    unstructured = Delivery(
        cloud_project_id=project.id,
        loop_item_id=item.id,
        status="delivered",
        title="Manual report",
        created_by_user_id=test_user.id,
    )
    test_db.add(unstructured)
    test_db.flush()
    nodes = {
        "stage-1": {
            "id": "stage-1",
            "name": "First",
            "delivery_ids": [foreign.id, deleted.id, draft.id, unstructured.id],
        },
        "stage-2": {"id": "stage-2", "name": "Second"},
    }

    catalog = workflow_delivery_catalog(test_db, item_id=item.id, nodes=nodes)

    assert {entry["delivery_id"] for entry in catalog} == {
        first.id,
        second.id,
        unstructured.id,
    }
    assert all(entry["superseded_by_delivery_id"] is None for entry in catalog)
    manual = next(entry for entry in catalog if entry["delivery_id"] == unstructured.id)
    assert manual["stage_id"] == "stage-1"
    assert manual["name"] == "Manual report"
    assert manual["requirement_id"] is None
