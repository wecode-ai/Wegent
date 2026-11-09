"""Security tests for random, persisted share tokens."""

import hashlib

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.core.security import get_password_hash
from app.models.kind import Kind
from app.models.share_link import ResourceType, ShareLink
from app.models.task import TaskResource
from app.models.user import User
from app.services.shared_task import shared_task_service
from app.services.shared_team import shared_team_service
from app.services.share import task_share_service
from app.services.task_invite_service import task_invite_service


def _add_user(db: Session, name: str) -> User:
    user = User(
        user_name=name,
        password_hash=get_password_hash(f"{name}-password"),
        email=f"{name}@example.com",
        is_active=True,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def _add_task(db: Session, owner: User, name: str) -> TaskResource:
    task = TaskResource(
        user_id=owner.id,
        kind="Task",
        name=name,
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Task",
            "metadata": {"name": name, "namespace": "default"},
            "spec": {
                "title": name,
                "prompt": "private prompt",
                "teamRef": {"name": "agent", "namespace": "default"},
                "workspaceRef": {"name": "workspace", "namespace": "default"},
            },
            "status": {"state": "Available", "status": "RUNNING"},
        },
        is_active=TaskResource.STATE_ACTIVE,
        client_origin="frontend",
        is_group_chat=False,
    )
    db.add(task)
    db.commit()
    db.refresh(task)
    return task


def _add_team(db: Session, owner: User, name: str) -> Kind:
    team = Kind(
        user_id=owner.id,
        kind="Team",
        name=name,
        namespace="default",
        is_active=True,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Team",
            "metadata": {"name": name, "namespace": "default"},
            "spec": {
                "name": name,
                "members": [],
                "collaborationModel": "single",
            },
        },
    )
    db.add(team)
    db.commit()
    db.refresh(team)
    return team


@pytest.mark.unit
def test_task_share_token_is_random_and_persisted(test_db: Session):
    owner = _add_user(test_db, "secure-task-owner")
    task = _add_task(test_db, owner, "secure-task")

    response = shared_task_service.share_task(test_db, task.id, owner.id)
    link = (
        test_db.query(ShareLink)
        .filter(
            ShareLink.resource_type == ResourceType.TASK.value,
            ShareLink.resource_id == task.id,
        )
        .one()
    )

    assert response.share_token == link.share_token
    assert len(response.share_token) >= 43
    assert (
        link.token_hash
        == hashlib.sha256(response.share_token.encode("utf-8")).hexdigest()
    )
    assert (
        shared_task_service.get_public_shared_task(
            test_db, response.share_token
        ).task_title
        == "secure-task"
    )


@pytest.mark.unit
def test_forged_task_token_cannot_read_public_task(test_db: Session):
    owner = _add_user(test_db, "forged-task-owner")
    task = _add_task(test_db, owner, "forged-task")
    shared_task_service.share_task(test_db, task.id, owner.id)

    with pytest.raises(HTTPException) as exc_info:
        shared_task_service.get_public_shared_task(test_db, "forged-token")

    assert exc_info.value.status_code == 400
    assert exc_info.value.detail == "Invalid share link format"


@pytest.mark.unit
def test_task_invite_and_share_tokens_are_not_interchangeable(
    test_db: Session,
):
    owner = _add_user(test_db, "invite-isolation-owner")
    task = _add_task(test_db, owner, "invite-isolation-task")
    share_link = shared_task_service.create_share_link(test_db, task.id, owner.id)
    invite_token = task_invite_service.generate_invite_token(
        test_db, task_id=task.id, inviter_id=owner.id
    )

    assert (
        test_db.query(ShareLink)
        .filter(ShareLink.share_token == invite_token)
        .one()
        .resource_type
        == ResourceType.TASK_INVITE.value
    )

    with pytest.raises(HTTPException) as share_error:
        shared_task_service.get_public_shared_task(test_db, invite_token)

    assert share_error.value.status_code == 400
    assert share_error.value.detail == "Invalid share link format"
    assert (
        task_invite_service.decode_invite_token(test_db, share_link.share_token) is None
    )


@pytest.mark.unit
def test_joining_shared_task_requires_own_target_team(test_db: Session):
    owner = _add_user(test_db, "join-target-owner")
    attacker = _add_user(test_db, "join-target-attacker")
    task = _add_task(test_db, owner, "join-target-task")
    owner_team = _add_team(test_db, owner, "join-target-owner-team")
    response = shared_task_service.share_task(test_db, task.id, owner.id)
    with pytest.raises(HTTPException) as exc_info:
        shared_task_service.join_shared_task(
            test_db,
            share_token=response.share_token,
            user_id=attacker.id,
            team_id=owner_team.id,
        )

    assert exc_info.value.status_code == 400
    assert exc_info.value.detail == f"Team with id {owner_team.id} not found"


@pytest.mark.unit
def test_team_share_token_is_random_and_persisted(test_db: Session):
    owner = _add_user(test_db, "secure-team-owner")
    team = _add_team(test_db, owner, "secure-team")

    response = shared_team_service.share_team(test_db, team.id, owner.id)
    link = (
        test_db.query(ShareLink)
        .filter(
            ShareLink.resource_type == ResourceType.TEAM.value,
            ShareLink.resource_id == team.id,
        )
        .one()
    )

    assert response.share_token == link.share_token
    assert len(response.share_token) >= 43
    assert (
        link.token_hash
        == hashlib.sha256(response.share_token.encode("utf-8")).hexdigest()
    )
    assert (
        shared_team_service.get_share_info(test_db, response.share_token).team_name
        == "secure-team"
    )


@pytest.mark.unit
def test_forged_team_token_cannot_read_team_info(test_db: Session):
    owner = _add_user(test_db, "forged-team-owner")
    _add_team(test_db, owner, "forged-team")

    with pytest.raises(HTTPException) as exc_info:
        shared_team_service.get_share_info(test_db, "forged-token")

    assert exc_info.value.status_code == 400
    assert exc_info.value.detail == "Invalid share token"


@pytest.mark.unit
def test_deleting_share_link_revokes_all_active_tokens(test_db: Session):
    owner = _add_user(test_db, "revocation-owner")
    task = _add_task(test_db, owner, "revocation-task")
    first = shared_task_service.create_share_link(test_db, task.id, owner.id)
    second = shared_task_service.create_share_link(test_db, task.id, owner.id)

    assert task_share_service.delete_share_link(
        test_db, resource_id=task.id, user_id=owner.id
    )

    for token in (first.share_token, second.share_token):
        link = (
            test_db.query(ShareLink)
            .filter(ShareLink.share_token == token)
            .one()
        )
        assert link.is_active is False
        assert shared_task_service.decode_share_token(token, test_db) is None
