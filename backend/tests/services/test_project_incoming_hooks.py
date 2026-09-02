# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Tests for project event-source normalization."""

import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from app.models.delivery import (
    CloudProject,
    LoopItem,
    LoopItemTaskBinding,
    ProjectAutomationRule,
    ProjectAutomationRun,
    ProjectIncomingEvent,
    ProjectIncomingHook,
)
from app.schemas.project_incoming_hook import ChangeRequestBindingInput
from app.services import runtime_work_service
from app.services.project_automation_domain import ProjectAutomationEvent
from app.services.project_change_request_bindings import (
    project_change_request_binding_service,
)
from app.services.project_event_sources import (
    event_source_catalog,
    normalize_observed_resource,
    normalize_webhook_events,
    resource_matches,
)
from app.services.project_incoming_hooks import (
    parse_incoming_body,
    project_incoming_hook_service,
)


def test_normalize_github_failed_check() -> None:
    events = normalize_webhook_events(
        "github",
        {
            "action": "completed",
            "check_run": {
                "id": 100,
                "status": "completed",
                "conclusion": "failure",
                "head_sha": "abc1234",
                "pull_requests": [
                    {
                        "number": 12,
                        "html_url": "https://github.example/acme/app/pull/12",
                        "head": {"ref": "fix/checks", "sha": "abc1234"},
                        "base": {"ref": "main"},
                    }
                ],
            },
            "repository": {
                "id": 42,
                "full_name": "acme/app",
                "html_url": "https://github.example/acme/app",
            },
        },
        {"x-github-event": "check_run"},
    )

    assert len(events) == 1
    assert events[0].event_type == "change_request.checks_failed"
    assert events[0].resource["path"] == "acme/app"
    assert events[0].subject["number"] == 12
    assert events[0].subject["head_commit"] == "abc1234"


def test_normalize_gitlab_merge_conflict() -> None:
    events = normalize_webhook_events(
        "gitlab",
        {
            "object_kind": "merge_request",
            "project": {
                "id": 9,
                "path_with_namespace": "acme/app",
                "web_url": "https://gitlab.example/acme/app",
            },
            "object_attributes": {
                "iid": 8,
                "url": "https://gitlab.example/acme/app/-/merge_requests/8",
                "source_branch": "fix/conflict",
                "target_branch": "main",
                "detailed_merge_status": "cannot_be_merged",
                "last_commit": {"id": "def5678"},
            },
        },
        {"x-gitlab-event": "Merge Request Hook"},
    )

    assert len(events) == 1
    assert events[0].event_type == "change_request.merge_conflict"
    assert events[0].subject["number"] == 8
    assert events[0].subject["repository"] == "acme/app"


def test_normalize_github_review_submitted() -> None:
    events = normalize_webhook_events(
        "github",
        {
            "action": "submitted",
            "review": {
                "id": 9,
                "state": "approved",
                "user": {"id": 1, "login": "alice"},
            },
            "pull_request": {
                "number": 12,
                "html_url": "https://github.example/acme/app/pull/12",
                "head": {"ref": "fix/review", "sha": "abc1234"},
                "base": {"ref": "main"},
            },
            "repository": {
                "id": 42,
                "full_name": "acme/app",
                "html_url": "https://github.example/acme/app",
            },
        },
        {"x-github-event": "pull_request_review"},
    )

    assert len(events) == 1
    assert events[0].event_type == "change_request.review_submitted"
    assert events[0].payload["author"] == {"id": 1, "login": "alice"}


def test_normalize_github_review_comment_created() -> None:
    events = normalize_webhook_events(
        "github",
        {
            "action": "created",
            "comment": {"id": 5, "user": {"id": 2, "login": "bob"}},
            "pull_request": {
                "number": 12,
                "html_url": "https://github.example/acme/app/pull/12",
                "head": {"ref": "fix/review", "sha": "abc1234"},
                "base": {"ref": "main"},
            },
            "repository": {
                "id": 42,
                "full_name": "acme/app",
                "html_url": "https://github.example/acme/app",
            },
        },
        {"x-github-event": "pull_request_review_comment"},
    )

    assert len(events) == 1
    assert events[0].event_type == "change_request.comment_created"
    assert events[0].payload["author"] == {"id": 2, "login": "bob"}


def test_normalize_gitlab_user_note_created() -> None:
    events = normalize_webhook_events(
        "gitlab",
        {
            "object_kind": "note",
            "user": {"id": 4, "username": "dave", "name": "Dave"},
            "object_attributes": {
                "id": 100,
                "note": "Please fix this",
                "system": False,
                "action": "create",
            },
            "merge_request": {
                "iid": 8,
                "url": "https://gitlab.example/acme/app/-/merge_requests/8",
                "source_branch": "fix/approve",
                "target_branch": "main",
                "last_commit": {"id": "def5678"},
            },
            "project": {
                "id": 9,
                "path_with_namespace": "acme/app",
                "web_url": "https://gitlab.example/acme/app",
            },
        },
        {"x-gitlab-event": "Note Hook"},
    )

    assert len(events) == 1
    assert events[0].event_type == "change_request.comment_created"
    assert events[0].payload["author"] == {
        "id": 4,
        "username": "dave",
        "name": "Dave",
    }


def test_normalize_gitlab_system_note_ignored() -> None:
    events = normalize_webhook_events(
        "gitlab",
        {
            "object_kind": "note",
            "object_attributes": {
                "id": 101,
                "note": "approved this merge request",
                "system": True,
                "action": "create",
            },
            "merge_request": {"iid": 8},
            "project": {
                "id": 9,
                "path_with_namespace": "acme/app",
                "web_url": "https://gitlab.example/acme/app",
            },
        },
        {"x-gitlab-event": "Note Hook"},
    )

    assert events == []


def test_normalize_gitlab_note_update_ignored() -> None:
    events = normalize_webhook_events(
        "gitlab",
        {
            "object_kind": "note",
            "user": {"id": 4, "username": "dave"},
            "object_attributes": {
                "id": 100,
                "note": "Please fix this",
                "system": False,
                "action": "update",
            },
            "merge_request": {"iid": 8},
            "project": {
                "id": 9,
                "path_with_namespace": "acme/app",
                "web_url": "https://gitlab.example/acme/app",
            },
        },
        {"x-gitlab-event": "Note Hook"},
    )

    assert events == []


def test_event_source_catalog_event_types_per_source() -> None:
    catalog = {item["source_type"]: item for item in event_source_catalog()}

    assert "change_request.review_submitted" in catalog["github"]["event_types"]
    assert "change_request.approved" not in catalog["github"]["event_types"]
    assert "change_request.approved" not in catalog["gitlab"]["event_types"]
    assert "change_request.review_submitted" not in catalog["gitlab"]["event_types"]


def test_observed_resource_matches_vendor_numeric_identity_by_path() -> None:
    configured = normalize_observed_resource(
        "github",
        {
            "resource_type": "repository",
            "url": "https://github.example/acme/app",
        },
    )
    observed = {
        "resource_type": "repository",
        "instance_url": "https://github.example",
        "external_id": "42",
        "path": "acme/app",
    }

    assert resource_matches(configured, observed)


def test_parse_json_object() -> None:
    assert parse_incoming_body(
        json.dumps({"event_type": "document.changed"}).encode(),
        "application/json",
    ) == {"event_type": "document.changed"}


@pytest.mark.parametrize(
    "raw",
    [
        b"",
        json.dumps(["not", "an", "object"]).encode(),
    ],
)
def test_parse_rejects_invalid_payload(raw: bytes) -> None:
    with pytest.raises(ValueError):
        parse_incoming_body(raw, "application/json")


@pytest.mark.asyncio
async def test_unresolved_change_request_event_resumes_after_binding(
    test_db,
    test_user,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project = CloudProject(
        project_key="REBIND",
        name="Late binding",
        created_by_user_id=test_user.id,
        storage_prefix="projects/late-binding",
    )
    test_db.add(project)
    test_db.flush()
    subscription = ProjectIncomingHook(
        public_id="late-binding-subscription",
        cloud_project_id=str(project.id),
        name="GitHub",
        source="github",
        status="active",
        created_by_user_id=test_user.id,
        metadata_json={
            "schema_version": 1,
            "source_type": "github",
            "collection_mode": "webhook",
            "resource": normalize_observed_resource(
                "github",
                {
                    "resource_type": "repository",
                    "url": "https://github.example/acme/app",
                },
            ),
        },
    )
    test_db.add(subscription)
    test_db.flush()
    rule = ProjectAutomationRule(
        cloud_project_id=str(project.id),
        title="Repair failed checks",
        description="Repair the failing checks.",
        status="enabled",
        created_by_user_id=test_user.id,
        metadata_json={
            "trigger_type": "event",
            "event_type": "change_request.checks_failed",
            "event_config": {
                "subscription_id": str(subscription.id),
                "execution_target": "continue_binding",
            },
        },
    )
    payload = {
        "action": "completed",
        "check_run": {
            "id": 100,
            "status": "completed",
            "conclusion": "failure",
            "head_sha": "abc1234",
            "pull_requests": [
                {
                    "number": 7,
                    "html_url": "https://github.example/acme/app/pull/7",
                    "head": {"ref": "fix/checks", "sha": "abc1234"},
                    "base": {"ref": "main"},
                }
            ],
        },
        "repository": {
            "id": 42,
            "full_name": "acme/app",
            "html_url": "https://github.example/acme/app",
        },
    }
    event = ProjectIncomingEvent(
        public_id="late-binding-event",
        cloud_project_id=str(project.id),
        parent_id=str(subscription.id),
        title="github: check_run",
        source="github",
        status="received",
        created_by_user_id=test_user.id,
        metadata_json={
            "schema_version": 1,
            "collection_mode": "webhook",
            "attempt_count": 0,
            "payload": payload,
            "headers": {"x-github-event": "check_run"},
        },
    )
    test_db.add_all([rule, event])
    test_db.commit()

    monkeypatch.setattr(
        "app.tasks.robot_queue_tasks.consume_queues_background",
        AsyncMock(),
    )
    await project_incoming_hook_service.process_event(test_db, str(event.id))

    test_db.refresh(event)
    first_run = test_db.query(ProjectAutomationRun).one()
    assert event.status == "unresolved"
    assert first_run.status == "skipped"
    assert "binding" in first_run.description.lower()

    item = LoopItem(
        cloud_project_id=str(project.id),
        title="Original task",
        status="pending",
        created_by_user_id=test_user.id,
    )
    test_db.add(item)
    test_db.flush()
    binding = LoopItemTaskBinding(
        cloud_project_id=str(project.id),
        loop_item_id=item.id,
        task_user_id=test_user.id,
        device_id="desktop-1",
        task_id="runtime-task-1",
        task_title="Original task",
        linked_by_user_id=test_user.id,
        metadata_json={},
    )
    test_db.add(binding)
    test_db.flush()
    project_change_request_binding_service.upsert(
        test_db,
        binding=binding,
        values=ChangeRequestBindingInput(
            provider="github",
            url="https://github.example/acme/app/pull/7",
            number=7,
            head_branch="fix/checks",
            base_branch="main",
            head_commit="abc1234",
            source="runtime",
        ),
    )

    test_db.refresh(event)
    assert event.status == "received"
    send_runtime_message = AsyncMock(
        return_value=SimpleNamespace(accepted=True, error=None)
    )
    monkeypatch.setattr(
        runtime_work_service,
        "send_runtime_message",
        send_runtime_message,
    )

    await project_incoming_hook_service.process_event(test_db, str(event.id))

    test_db.refresh(event)
    test_db.refresh(first_run)
    assert event.status == "processed"
    assert test_db.query(ProjectAutomationRun).count() == 1
    assert first_run.status == "succeeded"
    assert first_run.task_id == str(item.id)
    send_runtime_message.assert_awaited_once()


def test_change_request_cannot_bind_to_two_active_tasks(
    test_db,
    test_user,
) -> None:
    project = CloudProject(
        project_key="UNIQUECR",
        name="Unique change request",
        created_by_user_id=test_user.id,
        storage_prefix="projects/unique-change-request",
    )
    test_db.add(project)
    test_db.flush()
    first_item = LoopItem(
        cloud_project_id=project.id,
        title="First",
        status="pending",
        created_by_user_id=test_user.id,
    )
    second_item = LoopItem(
        cloud_project_id=project.id,
        title="Second",
        status="pending",
        created_by_user_id=test_user.id,
    )
    test_db.add_all([first_item, second_item])
    test_db.flush()
    first = LoopItemTaskBinding(
        cloud_project_id=project.id,
        loop_item_id=first_item.id,
        task_user_id=test_user.id,
        device_id="desktop-1",
        task_id="runtime-1",
        linked_by_user_id=test_user.id,
        metadata_json={},
    )
    second = LoopItemTaskBinding(
        cloud_project_id=project.id,
        loop_item_id=second_item.id,
        task_user_id=test_user.id,
        device_id="desktop-2",
        task_id="runtime-2",
        linked_by_user_id=test_user.id,
        metadata_json={},
    )
    test_db.add_all([first, second])
    test_db.flush()
    values = ChangeRequestBindingInput(
        provider="github",
        url="https://github.com/acme/app/pull/7",
        number=7,
        head_branch="fix/checks",
        base_branch="main",
        head_commit="abc1234",
        source="runtime",
    )

    project_change_request_binding_service.upsert(
        test_db,
        binding=first,
        values=values,
    )
    with pytest.raises(HTTPException) as exc_info:
        project_change_request_binding_service.upsert(
            test_db,
            binding=second,
            values=values,
        )

    assert exc_info.value.status_code == 409


def test_ambiguous_change_request_resolution_does_not_guess(
    test_db,
    test_user,
) -> None:
    project = CloudProject(
        project_key="AMBIGCR",
        name="Ambiguous change request",
        created_by_user_id=test_user.id,
        storage_prefix="projects/ambiguous-change-request",
    )
    test_db.add(project)
    test_db.flush()
    change_request = {
        "provider": "github",
        "instance_url": "https://github.com",
        "repository": "acme/app",
        "number": 7,
        "url": "https://github.com/acme/app/pull/7",
    }
    for index in range(2):
        item = LoopItem(
            cloud_project_id=project.id,
            title=f"Task {index}",
            status="pending",
            created_by_user_id=test_user.id,
        )
        test_db.add(item)
        test_db.flush()
        test_db.add(
            LoopItemTaskBinding(
                cloud_project_id=project.id,
                loop_item_id=item.id,
                task_user_id=test_user.id,
                device_id=f"desktop-{index}",
                task_id=f"runtime-{index}",
                linked_by_user_id=test_user.id,
                metadata_json={"change_requests": [change_request]},
            )
        )
    test_db.commit()

    resolution = project_change_request_binding_service.resolve(
        test_db,
        project_id=str(project.id),
        subject=change_request,
    )

    assert resolution.binding is None
    assert (
        resolution.reason == "Multiple active task bindings matched the change request"
    )


@pytest.mark.asyncio
async def test_internal_event_is_persisted_before_rule_matching(
    test_db,
    test_user,
) -> None:
    project = CloudProject(
        project_key="INTERNAL",
        name="Internal event",
        created_by_user_id=test_user.id,
        storage_prefix="projects/internal-event",
    )
    test_db.add(project)
    test_db.commit()

    dispatched = await project_incoming_hook_service.ingest_internal(
        test_db,
        ProjectAutomationEvent(
            event_type="task.created",
            project_id=str(project.id),
            subject_id="issue-1",
            subject_type="task",
            source="wework",
            actor_user_id=test_user.id,
            payload={"id": "issue-1"},
            event_id="task-created:issue-1",
        ),
    )

    assert dispatched == 0
    hook = test_db.query(ProjectIncomingHook).one()
    event = test_db.query(ProjectIncomingEvent).one()
    assert hook.source == "wework"
    assert hook.metadata_json["collection_mode"] == "internal"
    assert event.parent_id == hook.id
    assert event.status == "processed"
    assert event.metadata_json["normalized_events"][0]["event_type"] == "task.created"
