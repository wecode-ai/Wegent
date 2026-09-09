import uuid

from sqlalchemy.orm import Session

from app.models.delivery import CloudProject, Delivery, LoopItem, LoopItemTaskBinding
from app.services.workflow_deliverables import (
    fulfilled_requirement_ids,
    missing_requirement_ids,
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
