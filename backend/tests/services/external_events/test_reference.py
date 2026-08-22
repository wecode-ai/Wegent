# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Automatic reference binding for waiting workflow nodes."""

from __future__ import annotations

import uuid

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.delivery import (
    CloudProject,
    ExternalEventBinding,
    LoopItem,
    ProjectAutomationRun,
)
from app.models.user import User
from app.schemas.delivery import DeliveryPullRequestFulfillment
from app.services.delivery.service import DeliveryService
from app.services.external_events.adapters import (
    ProviderReferenceAdapter,
    provider_reference_adapter,
)
from app.services.external_events.reference import (
    INJECTED_REQUIREMENT_PREFIX,
    bind_references_from_delivery,
    injected_reference_requirements,
    resolved_workflow_requirements,
)


def _workflow_definition(rules: list[dict] | None = None) -> dict:
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
                    "rules": rules
                    or [
                        {
                            "id": "rule-merged",
                            "provider": "gitlab",
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
        project_key="REF",
        name="Reference project",
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
        title="Issue with wait node",
        description="",
        status="in_progress",
        priority="none",
        sort_order=0,
        created_by_user_id=user.id,
        metadata_json={"workflow": _workflow_definition()},
    )
    test_db.add(item)
    run = ProjectAutomationRun(
        id="run-1",
        cloud_project_id=str(project.id),
        task_id=item.id,
        task_title=item.title,
        status="pending",
        created_by_user_id=user.id,
    )
    test_db.add(run)
    test_db.commit()
    test_db.refresh(project)
    test_db.refresh(item)
    return project, item


def _stage(workflow: dict) -> dict:
    return next(
        node
        for node in workflow["nodes"]
        if isinstance(node, dict) and node.get("node_type") == "stage"
    )


def test_reference_adapter_registry_resolves_native_provider() -> None:
    adapter = provider_reference_adapter("gitlab")
    assert adapter is not None
    assert adapter.reference_kind == "pull_request"
    assert adapter.opaque_ref_format == "group/project!iid"
    assert provider_reference_adapter(" GITLAB ") is adapter
    assert provider_reference_adapter("youtube") is None


def test_gitlab_extracts_opaque_ref_from_pull_request_url() -> None:
    adapter = provider_reference_adapter("gitlab")
    assert adapter is not None
    assert adapter.extract_opaque_refs(
        {
            "kind": "pull_request",
            "provider": "gitlab",
            "url": "https://gitlab.example/acme/app/-/merge_requests/7",
            "number": 7,
        }
    ) == ("acme/app!7",)
    assert adapter.extract_opaque_refs(
        {
            "kind": "pull_request",
            "provider": "gitlab",
            "url": "https://gitlab.com/a/b/project/merge_requests/12",
            "number": 12,
        }
    ) == ("a/b/project!12",)
    # Percent-encoded project paths round-trip to the webhook adapter shape.
    assert adapter.extract_opaque_refs(
        {
            "kind": "pull_request",
            "provider": "gitlab",
            "url": "https://gitlab.example/my%20group/my%20project/-/merge_requests/3",
            "number": 3,
        }
    ) == ("my group/my project!3",)
    # Wrong fulfillment kind or missing fields yield no reference.
    assert (
        adapter.extract_opaque_refs({"kind": "url", "url": "https://gitlab.example/x"})
        == ()
    )
    assert (
        adapter.extract_opaque_refs(
            {"kind": "pull_request", "provider": "gitlab", "url": "", "number": 1}
        )
        == ()
    )


def test_injected_requirements_follow_downstream_wait_rules() -> None:
    workflow = _workflow_definition()
    stage = _stage(workflow)
    requirements = injected_reference_requirements(workflow, stage)
    assert requirements == [
        {
            "id": f"{INJECTED_REQUIREMENT_PREFIX}wait-1_gitlab",
            "name": "GitLab MR 引用",
            "value_type": "pull_request",
            "description": requirements[0]["description"],
        }
    ]

    # Rules without a provider never inject; the reference stays manual.
    workflow = _workflow_definition(
        [
            {
                "id": "rule-custom",
                "event_type": "my_event",
                "action": "rerun",
                "rerun_prompt": "",
            }
        ]
    )
    assert injected_reference_requirements(workflow, _stage(workflow)) == []


def test_resolved_requirements_merge_authored_and_injected() -> None:
    workflow = _workflow_definition()
    stage = dict(_stage(workflow))
    stage["required_deliverables"] = [
        {"id": "doc", "name": "说明文档", "value_type": "file"}
    ]
    ids = {
        requirement["id"]
        for requirement in resolved_workflow_requirements(workflow, stage)
    }
    assert ids == {"doc", f"{INJECTED_REQUIREMENT_PREFIX}wait-1_gitlab"}


def test_bind_references_from_delivery_registers_binding(
    test_db: Session,
    test_user: User,
) -> None:
    project, item = _issue(test_db, test_user)
    workflow = item.metadata_json["workflow"]
    stage = _stage(workflow)
    count = bind_references_from_delivery(
        test_db,
        item=item,
        workflow=workflow,
        node=stage,
        fulfillments=[
            {
                "requirement_id": f"{INJECTED_REQUIREMENT_PREFIX}wait-1_gitlab",
                "kind": "pull_request",
                "provider": "gitlab",
                "url": "https://gitlab.example/acme/app/-/merge_requests/7",
                "number": 7,
            }
        ],
        automation_run_id="run-1",
        user_id=test_user.id,
    )
    assert count == 1
    binding = (
        test_db.query(ExternalEventBinding)
        .filter(ExternalEventBinding.loop_item_id == item.id)
        .first()
    )
    assert binding is not None
    assert binding.provider == "gitlab"
    assert binding.opaque_ref == "acme/app!7"
    assert binding.metadata_json["workflow_node_id"] == "wait-1"


def test_binding_prefers_requirement_id_when_multiple_wait_nodes_share_provider(
    test_db: Session,
    test_user: User,
) -> None:
    project, item = _issue(test_db, test_user)
    workflow = item.metadata_json["workflow"]
    workflow["nodes"].append(
        {
            "id": "wait-2",
            "name": "Second wait",
            "node_type": "wait",
            "depends_on": ["stage-1"],
            "required": True,
            "workspace_policy": "none",
            "status": "waiting",
            "wait_config": {
                "rules": [
                    {
                        "id": "rule-ci",
                        "provider": "gitlab",
                        "event_type": "ci_failed",
                        "action": "complete",
                    },
                ]
            },
        }
    )
    item.metadata_json = {"workflow": workflow}
    test_db.commit()

    count = bind_references_from_delivery(
        test_db,
        item=item,
        workflow=workflow,
        node=_stage(workflow),
        fulfillments=[
            {
                "requirement_id": f"{INJECTED_REQUIREMENT_PREFIX}wait-2_gitlab",
                "kind": "pull_request",
                "provider": "gitlab",
                "url": "https://gitlab.example/acme/app/-/merge_requests/7",
                "number": 7,
            }
        ],
        automation_run_id="run-1",
        user_id=test_user.id,
    )

    assert count == 1
    binding = (
        test_db.query(ExternalEventBinding)
        .filter(ExternalEventBinding.loop_item_id == item.id)
        .first()
    )
    assert binding is not None
    assert binding.metadata_json["workflow_node_id"] == "wait-2"


def test_bind_ignores_non_reference_fulfillments(
    test_db: Session,
    test_user: User,
) -> None:
    project, item = _issue(test_db, test_user)
    workflow = item.metadata_json["workflow"]
    count = bind_references_from_delivery(
        test_db,
        item=item,
        workflow=workflow,
        node=_stage(workflow),
        fulfillments=[
            {"requirement_id": "doc", "kind": "text", "text": "nothing here"}
        ],
        automation_run_id="run-1",
        user_id=test_user.id,
    )
    assert count == 0


def test_new_reference_supersedes_same_provider_binding(
    test_db: Session,
    test_user: User,
) -> None:
    project, item = _issue(test_db, test_user)
    run_two = ProjectAutomationRun(
        id="run-2",
        cloud_project_id=str(project.id),
        task_id=item.id,
        task_title=item.title,
        status="pending",
        created_by_user_id=test_user.id,
    )
    test_db.add(run_two)
    test_db.commit()
    workflow = item.metadata_json["workflow"]
    stage = _stage(workflow)

    def _fulfillment(number: int) -> dict:
        return {
            "requirement_id": f"{INJECTED_REQUIREMENT_PREFIX}wait-1_gitlab",
            "kind": "pull_request",
            "provider": "gitlab",
            "url": f"https://gitlab.example/acme/app/-/merge_requests/{number}",
            "number": number,
        }

    bind_references_from_delivery(
        test_db,
        item=item,
        workflow=workflow,
        node=stage,
        fulfillments=[_fulfillment(7)],
        automation_run_id="run-1",
        user_id=test_user.id,
    )
    bind_references_from_delivery(
        test_db,
        item=item,
        workflow=workflow,
        node=stage,
        fulfillments=[_fulfillment(9)],
        automation_run_id="run-2",
        user_id=test_user.id,
    )

    rows = (
        test_db.query(ExternalEventBinding)
        .filter(ExternalEventBinding.loop_item_id == item.id)
        .all()
    )
    active = [
        row for row in rows if row.deleted_at is None or row.deleted_at.year <= 1970
    ]
    archived = [
        row for row in rows if row.deleted_at is not None and row.deleted_at.year > 1970
    ]
    assert [row.opaque_ref for row in active] == ["acme/app!9"]
    assert [row.opaque_ref for row in archived] == ["acme/app!7"]


def test_injected_requirement_is_enforced_by_finalize_validation(
    test_db: Session,
    test_user: User,
) -> None:
    project, item = _issue(test_db, test_user)
    workflow = item.metadata_json["workflow"]
    stage = _stage(workflow)
    with pytest.raises(HTTPException) as exc:
        DeliveryService._validate_fulfillments(workflow, stage, [], [])
    assert exc.value.status_code == 422

    fulfillment = DeliveryPullRequestFulfillment.model_validate(
        {
            "requirement_id": f"{INJECTED_REQUIREMENT_PREFIX}wait-1_gitlab",
            "kind": "pull_request",
            "provider": "gitlab",
            "url": "https://gitlab.example/acme/app/-/merge_requests/7",
            "number": 7,
            "state": "draft",
            "head_branch": "feat",
            "base_branch": "main",
            "head_commit": "0123456789abcdef0123456789abcdef01234567",
        }
    )
    values = DeliveryService._validate_fulfillments(workflow, stage, [], [fulfillment])
    assert values[0]["kind"] == "pull_request"


def test_generic_provider_adapter_plugs_in_without_special_cases(
    test_db: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A provider needing an exotic opaque reference (e.g. a YouTube video
    URL) only registers one adapter; the routing machinery stays untouched."""

    from app.services.external_events import adapters

    class YouTubeAdapter(ProviderReferenceAdapter):
        def extract_opaque_refs(self, fulfillment):
            if fulfillment.get("kind") != "url":
                return ()
            url = str(fulfillment.get("url") or "")
            return (url,) if url.startswith("https://www.youtube.com/watch") else ()

    youtube = YouTubeAdapter(
        provider="youtube",
        reference_kind="url",
        reference_name="YouTube 视频",
        reference_description="交付视频链接，系统据此登记等待事件。",
        opaque_ref_format="https://www.youtube.com/watch?v=<id>",
        opaque_ref_example="https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    )
    monkeypatch.setitem(adapters.PROVIDER_REFERENCE_ADAPTERS, "youtube", youtube)
    assert provider_reference_adapter("youtube") is youtube

    workflow = _workflow_definition(
        [
            {
                "id": "rule-video",
                "provider": "youtube",
                "event_type": "published",
                "action": "complete",
                "rerun_prompt": "",
            }
        ]
    )
    requirements = injected_reference_requirements(workflow, _stage(workflow))
    assert requirements[0]["value_type"] == "url"
    assert requirements[0]["id"] == f"{INJECTED_REQUIREMENT_PREFIX}wait-1_youtube"


def test_failed_registration_is_recorded_on_wait_node(
    test_db: Session,
    test_user: User,
) -> None:
    project, item = _issue(test_db, test_user)
    workflow = item.metadata_json["workflow"]
    wait_node = next(
        node
        for node in workflow["nodes"]
        if isinstance(node, dict) and node.get("id") == "wait-1"
    )
    # A node that is no longer ready/waiting refuses registration, and the
    # failure must land on the node instead of silently failing the delivery.
    wait_node["status"] = "blocked"
    item.metadata_json = {"workflow": workflow}
    test_db.flush()

    count = bind_references_from_delivery(
        test_db,
        item=item,
        workflow=workflow,
        node=_stage(workflow),
        fulfillments=[
            {
                "requirement_id": f"{INJECTED_REQUIREMENT_PREFIX}wait-1_gitlab",
                "kind": "pull_request",
                "provider": "gitlab",
                "url": "https://gitlab.example/acme/app/-/merge_requests/7",
                "number": 7,
            }
        ],
        automation_run_id="run-1",
        user_id=test_user.id,
    )
    assert count == 0
    test_db.refresh(item)
    persisted = item.metadata_json["workflow"]["nodes"]
    persisted_wait = next(
        node
        for node in persisted
        if isinstance(node, dict) and node.get("id") == "wait-1"
    )
    assert "registration failed" in persisted_wait["registration_error"]


def test_successful_registration_clears_wait_node_error(
    test_db: Session,
    test_user: User,
) -> None:
    project, item = _issue(test_db, test_user)
    workflow = item.metadata_json["workflow"]
    wait_node = next(
        node
        for node in workflow["nodes"]
        if isinstance(node, dict) and node.get("id") == "wait-1"
    )
    wait_node["registration_error"] = "registration failed for acme/app!6"
    item.metadata_json = {"workflow": workflow}
    test_db.flush()

    count = bind_references_from_delivery(
        test_db,
        item=item,
        workflow=workflow,
        node=_stage(workflow),
        fulfillments=[
            {
                "requirement_id": f"{INJECTED_REQUIREMENT_PREFIX}wait-1_gitlab",
                "kind": "pull_request",
                "provider": "gitlab",
                "url": "https://gitlab.example/acme/app/-/merge_requests/7",
                "number": 7,
            }
        ],
        automation_run_id="run-1",
        user_id=test_user.id,
    )
    assert count == 1
    test_db.refresh(item)
    persisted_wait = next(
        node
        for node in item.metadata_json["workflow"]["nodes"]
        if isinstance(node, dict) and node.get("id") == "wait-1"
    )
    assert "registration_error" not in persisted_wait
