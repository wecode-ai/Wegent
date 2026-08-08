# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Focused contracts for task assignment, robot approval, and queue state."""

import uuid

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.delivery import CloudProject, LoopItem, ProjectChatAgent
from app.models.loop_item_execution import LoopItemExecution
from app.models.resource_member import MemberStatus, ResourceMember
from app.models.share_link import ResourceType
from app.models.user import User
from app.schemas.base_role import BaseRole
from app.schemas.project_chat import LoopItemApproval, LoopItemAssign
from app.services.loop_items.service import loop_item_service


def _make_project(db: Session, user: User) -> CloudProject:
    public_id = str(uuid.uuid4())
    project = CloudProject(
        public_id=public_id,
        project_key=f"QUEUE{uuid.uuid4().hex[:6].upper()}",
        name="Queue project",
        description="",
        created_by_user_id=user.id,
        storage_prefix=f"projects/{public_id}",
        metadata_json={},
    )
    db.add(project)
    db.commit()
    db.refresh(project)
    return project


def _make_bot(
    db: Session,
    project: CloudProject,
    user: User,
    *,
    mode: str = "auto",
    visibility: str = "public",
) -> ProjectChatAgent:
    bot = ProjectChatAgent(
        id=f"B{uuid.uuid4().hex[:10]}",
        cloud_project_id=project.id,
        title="Queue Bot",
        name="Queue Bot",
        status="active",
        created_by_user_id=user.id,
        metadata_json={
            "runtime": "codex",
            "execution_mode": mode,
            "visibility": visibility,
        },
    )
    db.add(bot)
    db.commit()
    db.refresh(bot)
    return bot


def _make_item(db: Session, project: CloudProject, user: User) -> LoopItem:
    item = LoopItem(
        id=f"T{uuid.uuid4().hex[:10]}",
        cloud_project_id=project.id,
        title="Queued task",
        description="",
        status="inbox",
        created_by_user_id=user.id,
        metadata_json={},
    )
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


def _active_execution(db: Session, item: LoopItem) -> LoopItemExecution | None:
    return (
        db.query(LoopItemExecution)
        .filter(
            LoopItemExecution.loop_item_id == item.id,
            LoopItemExecution.status.in_(["pending_approval", "queued", "running"]),
        )
        .order_by(LoopItemExecution.id.desc())
        .first()
    )


def _make_member(db: Session, project: CloudProject, name: str, role: BaseRole) -> User:
    user = User(
        user_name=name,
        password_hash="unused",
        email=f"{name}@example.com",
        is_active=True,
    )
    db.add(user)
    db.flush()
    db.add(
        ResourceMember(
            resource_type=ResourceType.CLOUD_PROJECT.value,
            resource_id=project.id,
            entity_type="user",
            entity_id=str(user.id),
            role=role.value,
            status=MemberStatus.APPROVED.value,
        )
    )
    db.commit()
    db.refresh(user)
    return user


def test_assign_to_robot_enters_queue_with_history(
    test_db: Session, test_user: User
) -> None:
    project = _make_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user)
    item = _make_item(test_db, project, test_user)

    updated = loop_item_service.assign(
        test_db,
        project_id=int(project.id),
        item_id=item.id,
        user_id=test_user.id,
        values=LoopItemAssign(
            version=item.version, assignee_type="agent", assignee_id=bot.id
        ),
    )

    assert updated.assignee_agent_id == bot.id
    assert updated.assignee_user_id is None
    metadata = updated.metadata_json or {}
    history = metadata["assignment_history"]
    assert history[-1]["by_user_id"] == test_user.id
    assert history[-1]["to_type"] == "agent"
    assert history[-1]["to_id"] == bot.id
    execution = _active_execution(test_db, updated)
    assert execution is not None
    assert execution.status == "queued"
    assert execution.agent_id == bot.id
    assert execution.assigner_user_id == test_user.id


def test_assign_to_member_records_chain(test_db: Session, test_user: User) -> None:
    project = _make_project(test_db, test_user)
    member = _make_member(test_db, project, "assignee", BaseRole.Developer)
    item = _make_item(test_db, project, test_user)

    updated = loop_item_service.assign(
        test_db,
        project_id=int(project.id),
        item_id=item.id,
        user_id=test_user.id,
        values=LoopItemAssign(
            version=item.version,
            assignee_type="user",
            assignee_id=str(member.id),
        ),
    )

    assert updated.assignee_user_id == member.id
    assert updated.assignee_agent_id is None
    metadata = updated.metadata_json or {}
    assert metadata["assignment_history"][-1]["to_type"] == "user"
    assert metadata["assignment_history"][-1]["to_name"] == "assignee"
    assert _active_execution(test_db, updated) is None


def test_manual_approval_flow_only_creator_can_approve(
    test_db: Session, test_user: User
) -> None:
    project = _make_project(test_db, test_user)
    creator_bot = _make_bot(test_db, project, test_user, mode="manual_approval")
    member = _make_member(test_db, project, "developer", BaseRole.Developer)
    item = _make_item(test_db, project, test_user)

    assigned = loop_item_service.assign(
        test_db,
        project_id=int(project.id),
        item_id=item.id,
        user_id=test_user.id,
        values=LoopItemAssign(
            version=item.version,
            assignee_type="agent",
            assignee_id=creator_bot.id,
        ),
    )
    execution = _active_execution(test_db, assigned)
    assert execution is not None
    assert execution.status == "pending_approval"
    assert execution.approval_status == "pending"

    with pytest.raises(HTTPException, match="Only the robot creator"):
        loop_item_service.approve_run(
            test_db,
            project_id=int(project.id),
            item_id=item.id,
            user_id=member.id,
            values=LoopItemApproval(version=assigned.version),
        )

    approved = loop_item_service.approve_run(
        test_db,
        project_id=int(project.id),
        item_id=item.id,
        user_id=test_user.id,
        values=LoopItemApproval(version=assigned.version),
    )
    execution = _active_execution(test_db, approved)
    assert execution is not None
    assert execution.status == "queued"
    assert execution.approval_status == "approved"
    assert execution.approved_by_user_id == test_user.id


def test_reject_run_cancels_with_reason(test_db: Session, test_user: User) -> None:
    project = _make_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user, mode="manual_approval")
    item = _make_item(test_db, project, test_user)

    assigned = loop_item_service.assign(
        test_db,
        project_id=int(project.id),
        item_id=item.id,
        user_id=test_user.id,
        values=LoopItemAssign(
            version=item.version,
            assignee_type="agent",
            assignee_id=bot.id,
        ),
    )
    rejected = loop_item_service.reject_run(
        test_db,
        project_id=int(project.id),
        item_id=item.id,
        user_id=test_user.id,
        values=LoopItemApproval(version=assigned.version, reason="Not now"),
    )
    execution = (
        test_db.query(LoopItemExecution)
        .filter(LoopItemExecution.loop_item_id == rejected.id)
        .order_by(LoopItemExecution.id.desc())
        .first()
    )
    assert execution is not None
    assert execution.status == "cancelled"
    assert execution.approval_status == "rejected"
    assert execution.rejected_reason == "Not now"


def test_approve_with_stale_version_has_no_side_effects(
    test_db: Session, test_user: User
) -> None:
    """A stale-version approve must 409 and leave the run pending.

    Regression: approve used to commit the run transition before the item
    version check, so a conflicting request half-applied the approval and
    dispatched the run even though the client saw "TODO changed".
    """

    project = _make_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user, mode="manual_approval")
    item = _make_item(test_db, project, test_user)
    assigned = loop_item_service.assign(
        test_db,
        project_id=int(project.id),
        item_id=item.id,
        user_id=test_user.id,
        values=LoopItemAssign(
            version=item.version,
            assignee_type="agent",
            assignee_id=bot.id,
        ),
    )
    execution = _active_execution(test_db, assigned)
    assert execution is not None
    assert execution.status == "pending_approval"

    with pytest.raises(HTTPException, match="TODO changed"):
        loop_item_service.approve_run(
            test_db,
            project_id=int(project.id),
            item_id=item.id,
            user_id=test_user.id,
            values=LoopItemApproval(version=assigned.version + 1),
        )

    execution = _active_execution(test_db, assigned)
    assert execution is not None
    assert execution.status == "pending_approval"
    assert execution.approval_status == "pending"
    assert execution.approved_by_user_id != test_user.id


def test_reject_with_stale_version_has_no_side_effects(
    test_db: Session, test_user: User
) -> None:
    """A stale-version reject must 409 and leave the run pending."""

    project = _make_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user, mode="manual_approval")
    item = _make_item(test_db, project, test_user)
    assigned = loop_item_service.assign(
        test_db,
        project_id=int(project.id),
        item_id=item.id,
        user_id=test_user.id,
        values=LoopItemAssign(
            version=item.version,
            assignee_type="agent",
            assignee_id=bot.id,
        ),
    )
    execution = _active_execution(test_db, assigned)
    assert execution is not None
    assert execution.status == "pending_approval"

    with pytest.raises(HTTPException, match="TODO changed"):
        loop_item_service.reject_run(
            test_db,
            project_id=int(project.id),
            item_id=item.id,
            user_id=test_user.id,
            values=LoopItemApproval(version=assigned.version + 1),
        )

    execution = _active_execution(test_db, assigned)
    assert execution is not None
    assert execution.status == "pending_approval"
    assert execution.approval_status == "pending"


def test_reassign_cancels_running_run_and_emits_runtime_cancel(
    test_db: Session, test_user: User, monkeypatch
) -> None:
    """Reassigning a task away from a running robot must ask the executor to
    stop the old run, not just mark the DB row cancelled.

    Regression: only the row changed, so the executor kept running the old
    task (zombie run) and occupied the device slot.
    """

    project = _make_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user)
    member = _make_member(test_db, project, "developer", BaseRole.Developer)
    item = _make_item(test_db, project, test_user)

    assigned = loop_item_service.assign(
        test_db,
        project_id=int(project.id),
        item_id=item.id,
        user_id=test_user.id,
        values=LoopItemAssign(
            version=item.version,
            assignee_type="agent",
            assignee_id=bot.id,
        ),
    )
    execution = _active_execution(test_db, assigned)
    assert execution is not None
    execution.runtime_device_id = "local-device"
    execution.runtime_task_id = "codex-queue-99"
    test_db.commit()

    emitted: list[LoopItemExecution] = []
    monkeypatch.setattr(
        "app.tasks.robot_queue_tasks.emit_runtime_cancels",
        lambda runs: emitted.extend(runs),
    )

    updated = loop_item_service.assign(
        test_db,
        project_id=int(project.id),
        item_id=item.id,
        user_id=test_user.id,
        values=LoopItemAssign(
            version=assigned.version,
            assignee_type="user",
            assignee_id=str(member.id),
        ),
    )

    assert _active_execution(test_db, updated) is None
    assert [run.id for run in emitted] == [execution.id]


def test_assign_requires_admin_and_visible_bot(
    test_db: Session, test_user: User
) -> None:
    project = _make_project(test_db, test_user)
    private_bot = _make_bot(test_db, project, test_user, visibility="private")
    developer = _make_member(test_db, project, "dev", BaseRole.Developer)
    maintainer = _make_member(test_db, project, "admin", BaseRole.Maintainer)
    item = _make_item(test_db, project, test_user)

    with pytest.raises(HTTPException, match="Insufficient permission"):
        loop_item_service.assign(
            test_db,
            project_id=int(project.id),
            item_id=item.id,
            user_id=developer.id,
            values=LoopItemAssign(
                version=item.version,
                assignee_type="agent",
                assignee_id=private_bot.id,
            ),
        )

    with pytest.raises(HTTPException, match="not visible"):
        loop_item_service.assign(
            test_db,
            project_id=int(project.id),
            item_id=item.id,
            user_id=maintainer.id,
            values=LoopItemAssign(
                version=item.version,
                assignee_type="agent",
                assignee_id=private_bot.id,
            ),
        )


def test_queue_listing_is_a_projection_of_assigned_tasks(
    test_db: Session, test_user: User
) -> None:
    project = _make_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user)
    member = _make_member(test_db, project, "worker", BaseRole.Developer)
    queued_item = _make_item(test_db, project, test_user)
    completed_item = _make_item(test_db, project, test_user)
    completed_item.status = "completed"
    test_db.commit()

    loop_item_service.assign(
        test_db,
        project_id=int(project.id),
        item_id=queued_item.id,
        user_id=test_user.id,
        values=LoopItemAssign(
            version=queued_item.version,
            assignee_type="agent",
            assignee_id=bot.id,
        ),
    )
    loop_item_service.assign(
        test_db,
        project_id=int(project.id),
        item_id=completed_item.id,
        user_id=test_user.id,
        values=LoopItemAssign(
            version=completed_item.version,
            assignee_type="user",
            assignee_id=str(member.id),
        ),
    )

    bot_queue = loop_item_service.list(
        test_db,
        int(project.id),
        test_user.id,
        assignee_type="agent",
        assignee_id=bot.id,
        execution_state="queued",
    )
    assert [item.id for item in bot_queue] == [queued_item.id]

    member_queue = loop_item_service.list(
        test_db,
        int(project.id),
        test_user.id,
        assignee_type="user",
        assignee_id=str(member.id),
    )
    assert [item.id for item in member_queue] == [completed_item.id]
