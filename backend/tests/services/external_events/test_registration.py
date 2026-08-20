# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Registration service coverage for external event bindings."""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy.orm import Session

from app.models.delivery import CloudProject, ExternalEventBinding, LoopItem
from app.models.user import User
from app.services.external_events.registration import (
    external_event_registration_service,
)


def test_provider_kind_classifies_native_and_generic_providers() -> None:
    from app.services.external_events.adapters import provider_kind

    assert provider_kind("gitlab") == "native"
    assert provider_kind("gitea") == "generic"
    assert provider_kind("my-crm") == "generic"
    assert provider_kind(" generic ") == "generic"


def _workflow_definition() -> dict:
    return {
        "version": 1,
        "stage_mode": "dag",
        "advancement_policy": "manual",
        "nodes": [
            {
                "id": "stage-1",
                "name": "Develop MR",
                "node_type": "stage",
                "depends_on": [],
                "required": True,
                "workspace_policy": "composer",
                "status": "completed",
            },
            {
                "id": "wait-1",
                "name": "Wait external",
                "node_type": "wait",
                "depends_on": ["stage-1"],
                "required": True,
                "workspace_policy": "none",
                "status": "waiting",
                "wait_config": {
                    "rules": [
                        {
                            "id": "rule-merged",
                            "event_type": "merged",
                            "action": "complete",
                            "rerun_prompt": "",
                        }
                    ]
                },
            },
        ],
    }


def _issue(test_db: Session, user: User) -> tuple[CloudProject, LoopItem]:
    public_id = str(uuid.uuid4())
    project = CloudProject(
        public_id=public_id,
        project_key="REG",
        name="Registration project",
        description="",
        created_by_user_id=user.id,
        storage_prefix=f"projects/{public_id}",
    )
    test_db.add(project)
    test_db.flush()
    item = LoopItem(
        id=f"{project.project_key}-1",
        cloud_project_id=str(project.id),
        sequence_number=1,
        title="Issue with preset workflow",
        description="",
        status="in_progress",
        priority="none",
        sort_order=0,
        created_by_user_id=user.id,
        metadata_json={"workflow": _workflow_definition()},
    )
    test_db.add(item)
    test_db.commit()
    test_db.refresh(project)
    test_db.refresh(item)
    return project, item


def test_register_creates_binding_and_marks_wait_node_waiting(
    test_db: Session,
    test_user: User,
) -> None:
    project, item = _issue(test_db, test_user)

    result = external_event_registration_service.register(
        test_db,
        user_id=test_user.id,
        cloud_project_id=str(project.id),
        loop_item_id=item.id,
        provider="gitlab",
        opaque_ref="acme/app!7",
        automation_run_id="run-1",
    )

    assert result["provider"] == "gitlab"
    assert result["opaque_ref"] == "acme/app!7"
    assert result["task_id"] == item.id
    assert result["issue_id"] == item.id
    assert result["workflow_node_id"] == "wait-1"
    assert result["compensated_event_count"] == 0
    binding = test_db.get(ExternalEventBinding, result["binding_id"])
    assert binding is not None
    assert binding.provider == "gitlab"
    assert binding.opaque_ref == "acme/app!7"
    assert binding.loop_item_id == item.id
    assert binding.metadata_json["automation_run_id"] == "run-1"
    test_db.refresh(item)
    wait_node = next(
        node
        for node in item.metadata_json["workflow"]["nodes"]
        if node["id"] == "wait-1"
    )
    assert wait_node["status"] == "waiting"


def test_register_generic_provider_passes_through_unchanged(
    test_db: Session,
    test_user: User,
) -> None:
    project, item = _issue(test_db, test_user)

    result = external_event_registration_service.register(
        test_db,
        user_id=test_user.id,
        cloud_project_id=str(project.id),
        loop_item_id=item.id,
        provider="gitea",
        opaque_ref="acme/app#7",
        automation_run_id="run-1",
    )

    assert result["provider"] == "gitea"
    assert result["provider_kind"] == "generic"
    binding = test_db.get(ExternalEventBinding, result["binding_id"])
    assert binding is not None
    assert binding.provider == "gitea"
    assert binding.opaque_ref == "acme/app#7"


def test_register_requires_automation_run_id(
    test_db: Session,
    test_user: User,
) -> None:
    project, item = _issue(test_db, test_user)

    with pytest.raises(ValueError, match="automation execution"):
        external_event_registration_service.register(
            test_db,
            user_id=test_user.id,
            cloud_project_id=str(project.id),
            loop_item_id=item.id,
            provider="gitlab",
            opaque_ref="acme/app!7",
            automation_run_id="",
        )


def test_register_rejects_item_outside_project(
    test_db: Session,
    test_user: User,
) -> None:
    project, _item = _issue(test_db, test_user)
    other = CloudProject(
        public_id=str(uuid.uuid4()),
        project_key="OTHER",
        name="Other project",
        description="",
        created_by_user_id=test_user.id,
        storage_prefix=f"projects/{uuid.uuid4()}",
    )
    test_db.add(other)
    test_db.commit()

    with pytest.raises(ValueError, match="not found in this space"):
        external_event_registration_service.register(
            test_db,
            user_id=test_user.id,
            cloud_project_id=str(project.id),
            loop_item_id=f"{other.project_key}-1",
            provider="gitlab",
            opaque_ref="acme/app!7",
            automation_run_id="run-1",
        )


def test_register_rejects_issue_without_wait_node(
    test_db: Session,
    test_user: User,
) -> None:
    project, item = _issue(test_db, test_user)
    metadata = dict(item.metadata_json or {})
    workflow = dict(metadata["workflow"])
    workflow["nodes"] = [node for node in workflow["nodes"] if node["id"] != "wait-1"]
    metadata["workflow"] = workflow
    item.metadata_json = metadata
    test_db.commit()

    with pytest.raises(ValueError, match="wait node"):
        external_event_registration_service.register(
            test_db,
            user_id=test_user.id,
            cloud_project_id=str(project.id),
            loop_item_id=item.id,
            provider="gitlab",
            opaque_ref="acme/app!7",
            automation_run_id="run-1",
        )
