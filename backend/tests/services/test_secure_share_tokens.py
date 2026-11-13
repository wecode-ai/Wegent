"""Security tests for random, persisted share tokens."""

import hashlib
import logging
import re
import traceback
from datetime import datetime, timedelta
from urllib.parse import parse_qs, urlsplit

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.core.security import get_password_hash
from app.models.kind import Kind
from app.models.resource_member import MemberStatus, ResourceMember
from app.models.share_link import ResourceType, ShareLink
from app.models.task import TaskResource
from app.models.user import User
from app.schemas.share import ShareLinkConfig
from app.services.share import task_share_service
from app.services.shared_task import shared_task_service
from app.services.shared_team import shared_team_service
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
            ShareLink.resource_type == ResourceType.TASK_SHARE.value,
            ShareLink.resource_id == task.id,
        )
        .one()
    )

    assert response.share_token == link.share_token
    assert len(response.share_token) >= 43
    assert re.fullmatch(r"[A-Za-z0-9_-]{43,}", response.share_token)
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
    assert re.fullmatch(r"[A-Za-z0-9_-]{43,}", response.share_token)
    assert (
        link.token_hash
        == hashlib.sha256(response.share_token.encode("utf-8")).hexdigest()
    )
    assert (
        shared_team_service.get_share_info(test_db, response.share_token).team_name
        == "secure-team"
    )


@pytest.mark.unit
def test_persisted_legacy_task_link_remains_usable(test_db: Session):
    owner = _add_user(test_db, "legacy-task-owner")
    task = _add_task(test_db, owner, "legacy-task")
    raw_token = "legacy-aes+token="
    link = ShareLink(
        resource_type=ResourceType.TASK.value,
        resource_id=task.id,
        share_token="legacy-aes%2Btoken%3D",
        token_hash=hashlib.sha256(raw_token.encode("utf-8")).hexdigest(),
        token_version=ShareLink.LEGACY_TOKEN_VERSION,
        require_approval=False,
        default_role="Reporter",
        expires_at=datetime.utcnow() + timedelta(days=365),
        created_by_user_id=owner.id,
        is_active=True,
    )
    test_db.add(link)
    test_db.commit()

    with pytest.raises(HTTPException) as error:
        shared_task_service.get_public_shared_task(test_db, raw_token)
    assert error.value.status_code == 401
    response = shared_task_service.get_public_shared_task(test_db, raw_token, owner.id)
    assert response.task_title == "legacy-task"
    existing_link = task_share_service.get_share_link(test_db, task.id, owner.id)
    assert existing_link.share_url == (
        f"{task_share_service._get_share_url_base()}?token={link.share_token}"
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
def test_team_join_honors_link_expiry_approval_and_role(test_db: Session):
    owner = _add_user(test_db, "team-link-owner")
    joiner = _add_user(test_db, "team-link-joiner")
    team = _add_team(test_db, owner, "team-link-team")
    link = shared_team_service.create_share_link(test_db, team.id, owner.id)

    link.require_approval = True
    link.default_role = "Developer"
    test_db.commit()

    response = shared_team_service.join_shared_team(
        test_db, link.share_token, joiner.id
    )
    member = (
        test_db.query(ResourceMember)
        .filter(
            ResourceMember.resource_id == team.id,
            ResourceMember.entity_id == str(joiner.id),
        )
        .one()
    )

    assert response.message == "Request submitted for approval"
    assert member.status == MemberStatus.PENDING.value
    assert member.role == "Developer"
    assert member.share_link_id == link.id

    link.expires_at = datetime.utcnow() - timedelta(seconds=1)
    test_db.commit()
    with pytest.raises(HTTPException) as exc_info:
        shared_team_service.join_shared_team(
            test_db, link.share_token, _add_user(test_db, "expired-link-joiner").id
        )

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
        link = test_db.query(ShareLink).filter(ShareLink.share_token == token).one()
        assert link.is_active is False
        assert shared_task_service.decode_share_token(token, test_db) is None


@pytest.mark.unit
@pytest.mark.parametrize("require_approval", [True, False])
def test_unified_task_tokens_cannot_use_direct_read_or_copy(
    test_db: Session, require_approval: bool
):
    owner = _add_user(test_db, "unified-token-owner")
    viewer = _add_user(test_db, "unified-token-viewer")
    task = _add_task(test_db, owner, "unified-token-task")
    link = task_share_service.create_share_link(
        test_db, task.id, owner.id, ShareLinkConfig(require_approval=require_approval)
    )
    url = urlsplit(link.share_url)
    assert url.path.endswith("/shared/task/access")
    assert parse_qs(url.query)["token"] == [link.share_token]
    preview = task_share_service.get_share_info(test_db, link.share_token)
    assert preview.resource_type == "Task"
    assert preview.resource_name == task.name
    assert preview.require_approval is require_approval

    with pytest.raises(HTTPException) as read_error:
        shared_task_service.get_public_shared_task(test_db, link.share_token)
    assert read_error.value.status_code == 400
    assert shared_task_service.decode_share_token(link.share_token, test_db) is None
    with pytest.raises(HTTPException) as copy_error:
        shared_task_service.join_shared_task(
            test_db, link.share_token, viewer.id, team_id=0
        )
    assert copy_error.value.status_code == 400
    assert test_db.query(ResourceMember).count() == 0

    response = task_share_service.join_by_link(test_db, link.share_token, viewer.id)
    member = test_db.query(ResourceMember).one()
    expected_status = "pending" if require_approval else "approved"
    assert response.status.value == expected_status
    assert member.status == expected_status
    assert member.share_link_id == link.id


@pytest.mark.unit
def test_unified_task_link_creation_does_not_reuse_public_or_invite_tokens(
    test_db: Session,
):
    owner = _add_user(test_db, "separate-link-owner")
    viewer = _add_user(test_db, "separate-link-viewer")
    task = _add_task(test_db, owner, "separate-link-task")
    public = shared_task_service.create_share_link(test_db, task.id, owner.id)
    invite_token = task_invite_service.generate_invite_token(test_db, task.id, owner.id)

    unified = task_share_service.create_share_link(
        test_db, task.id, owner.id, ShareLinkConfig(require_approval=True)
    )

    test_db.refresh(public)
    assert public.resource_type == "TaskShare"
    assert unified.id != public.id
    assert unified.share_token not in (public.share_token, invite_token)
    assert public.require_approval is False
    assert shared_task_service.get_public_shared_task(test_db, public.share_token)
    with pytest.raises(HTTPException) as join_error:
        task_share_service.join_by_link(test_db, public.share_token, viewer.id)
    assert join_error.value.status_code == 400
    assert task_invite_service.decode_invite_token(test_db, public.share_token) is None

    task_share_service.delete_share_link(test_db, task.id, owner.id)
    assert shared_task_service.decode_share_token(public.share_token, test_db) is None
    assert task_share_service._find_share_link(test_db, unified.share_token) is None
    assert task_invite_service.decode_invite_token(test_db, invite_token)


@pytest.mark.unit
def test_share_link_commit_error_does_not_log_bearer(
    test_db: Session, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
):
    owner = _add_user(test_db, "error-log-owner")
    task = _add_task(test_db, owner, "error-log-task")
    token = "synthetic-bearer-must-not-appear-in-logs"
    monkeypatch.setattr(task_share_service, "_generate_share_token", lambda *_: token)

    def fail_commit():
        raise RuntimeError(f"Database parameters contain {token}")

    monkeypatch.setattr(test_db, "commit", fail_commit)
    with caplog.at_level(logging.INFO), pytest.raises(HTTPException) as error:
        task_share_service.create_share_link(
            test_db, task.id, owner.id, ShareLinkConfig(require_approval=False)
        )
    assert error.value.status_code == 500
    assert token not in "".join(traceback.format_exception(error.value))
    assert token not in caplog.text
    assert "RuntimeError" in caplog.text


@pytest.mark.unit
def test_share_fixture_team_does_not_break_bot_reference_scans(test_db: Session):
    from app.services.adapters.bot_kinds import bot_kinds_service
    from tests.e2e.legacy_share_state import build_shared_resource

    owner = _add_user(test_db, "fixture-team-owner")
    name = "e2e-legacy-share-fixture-Team"
    test_db.add(
        Kind(
            user_id=owner.id,
            kind="Team",
            name=name,
            namespace="default",
            is_active=True,
            json=build_shared_resource(name, "Team"),
        )
    )
    test_db.commit()

    assert (
        bot_kinds_service._get_teams_using_bot(
            test_db, "unrelated-bot", "default", owner.id
        )
        == []
    )
