"""Legacy locators must not confer read, copy, or join permission."""

from datetime import datetime, timedelta

import pytest
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.dialects.mysql import dialect
from sqlalchemy.orm import Session

from app.models.resource_member import MemberStatus, ResourceMember, ResourceRole
from app.models.share_link import ResourceType, ShareLink
from app.schemas.share import ShareLinkConfig
from app.services.share import (
    knowledge_share_service,
    task_share_service,
    team_share_service,
)
from app.services.share.token_access import hash_share_token, share_token_lookup
from app.services.shared_task import shared_task_service
from app.services.shared_team import shared_team_service
from app.services.task_invite_service import task_invite_service
from tests.services.test_secure_share_tokens import _add_task, _add_team, _add_user

pytestmark = pytest.mark.unit


def test_lookup_parameters_do_not_include_raw_share_tokens():
    token = "opaque-token-that-must-not-appear-in-database-error-parameters"
    query = select(ShareLink.id).where(share_token_lookup(token))
    parameters = query.compile(dialect=dialect()).params
    assert token not in parameters.values()
    assert hash_share_token(token) in parameters.values()


def _legacy(db: Session, resource, resource_type: ResourceType) -> ShareLink:
    token = f"legacy-{resource_type.value}-{resource.id}%2B%3D"
    link = ShareLink(
        resource_type=resource_type.value,
        resource_id=resource.id,
        created_by_user_id=resource.user_id,
        share_token=token,
        token_hash=hash_share_token(token),
        token_version=ShareLink.LEGACY_TOKEN_VERSION,
        require_approval=False,
        default_role=ResourceRole.Reporter.value,
        expires_at=datetime.utcnow() + timedelta(days=1),
        is_active=True,
    )
    db.add(link)
    db.commit()
    return link


def _member(db: Session, resource, user, resource_type: ResourceType):
    member = ResourceMember(
        resource_type=resource_type.value,
        resource_id=resource.id,
        entity_type="user",
        entity_id=str(user.id),
        user_id=user.id,
        role=ResourceRole.Reporter.value,
        status=MemberStatus.APPROVED.value,
        copied_resource_id=0,
    )
    db.add(member)
    db.commit()
    return member


@pytest.mark.parametrize("reader", ["public", "decode", "unified"])
@pytest.mark.parametrize("has_hash", [True, False])
def test_legacy_task_requires_existing_current_permission(test_db, reader, has_hash):
    owner = _add_user(test_db, "legacy-owner")
    viewer = _add_user(test_db, "legacy-viewer")
    task = _add_task(test_db, owner, "legacy-task")
    link = _legacy(test_db, task, ResourceType.TASK)
    if not has_hash:
        link.token_hash = None
        test_db.commit()

    def read(uid):
        if reader == "public":
            return shared_task_service.get_public_shared_task(
                test_db, link.share_token, uid
            )
        if reader == "decode":
            return shared_task_service.decode_share_token(
                link.share_token, test_db, uid
            )
        return task_share_service.get_share_info(test_db, link.share_token, uid)

    for uid, status in [(None, 401), (viewer.id, 403)]:
        with pytest.raises(HTTPException) as error:
            read(uid)
        assert error.value.status_code == status
    assert read(owner.id)
    member = _member(test_db, task, viewer, ResourceType.TASK)
    assert read(viewer.id)
    member.status = MemberStatus.REJECTED.value
    test_db.commit()
    with pytest.raises(HTTPException) as error:
        read(viewer.id)
    assert error.value.status_code == 403


@pytest.mark.parametrize("operation", ["copy", "join", "invite"])
@pytest.mark.parametrize("has_hash", [True, False])
def test_legacy_task_cannot_grant_membership(test_db, operation, has_hash):
    owner = _add_user(test_db, "legacy-join-owner")
    outsider = _add_user(test_db, "legacy-join-outsider")
    task = _add_task(test_db, owner, "legacy-join-task")
    kind = ResourceType.TASK_INVITE if operation == "invite" else ResourceType.TASK
    link = _legacy(test_db, task, kind)
    if not has_hash:
        link.token_hash = None
        test_db.commit()
    with pytest.raises(HTTPException) as error:
        if operation == "copy":
            shared_task_service.join_shared_task(
                test_db, link.share_token, outsider.id, team_id=0
            )
        elif operation == "join":
            task_share_service.join_by_link(test_db, link.share_token, outsider.id)
        else:
            task_invite_service.decode_invite_token(
                test_db, link.share_token, outsider.id
            )
    assert error.value.status_code == 403
    assert test_db.query(ResourceMember).count() == 0


@pytest.mark.parametrize("kind", [ResourceType.TEAM, ResourceType.KNOWLEDGE_BASE])
@pytest.mark.parametrize("has_hash", [True, False])
def test_legacy_configuration_links_require_permission(test_db, kind, has_hash):
    owner = _add_user(test_db, "legacy-config-owner")
    viewer = _add_user(test_db, "legacy-config-viewer")
    resource = _add_team(test_db, owner, "legacy-config")
    resource.kind = kind.value
    test_db.commit()
    link = _legacy(test_db, resource, kind)
    if not has_hash:
        link.token_hash = None
        test_db.commit()
    service = (
        team_share_service if kind == ResourceType.TEAM else knowledge_share_service
    )
    for uid, status in [(None, 401), (viewer.id, 403)]:
        with pytest.raises(HTTPException) as error:
            service.get_share_info(test_db, link.share_token, uid)
        assert error.value.status_code == status
    assert service.get_share_info(test_db, link.share_token, owner.id)
    _member(test_db, resource, viewer, kind)
    assert service.get_share_info(test_db, link.share_token, viewer.id)
    if kind == ResourceType.TEAM:
        assert shared_team_service.get_share_info(test_db, link.share_token, viewer.id)
    else:
        assert (
            knowledge_share_service.get_public_kb_info(
                test_db, link.share_token, viewer.id
            )["id"]
            == resource.id
        )


def test_new_share_preserves_legacy_url_without_leaking_new_bearer(test_db):
    owner = _add_user(test_db, "legacy-reissue-owner")
    viewer = _add_user(test_db, "legacy-reissue-viewer")
    resource = _add_team(test_db, owner, "legacy-reissue")
    resource.kind = "KnowledgeBase"
    test_db.commit()
    old = _legacy(test_db, resource, ResourceType.KNOWLEDGE_BASE)
    _member(test_db, resource, viewer, ResourceType.KNOWLEDGE_BASE)
    new = knowledge_share_service.create_share_link(
        test_db, resource.id, owner.id, ShareLinkConfig(require_approval=False)
    )
    test_db.refresh(old)
    assert old.is_active and old.token_version == 1
    assert new.id != old.id and new.share_token != old.share_token
    assert (
        knowledge_share_service.get_public_kb_info(test_db, new.share_token)["id"]
        == resource.id
    )
    assert (
        knowledge_share_service.get_share_token_by_kb_id(test_db, resource.id, owner.id)
        == new.share_token
    )
    assert (
        knowledge_share_service.get_share_token_by_kb_id(
            test_db, resource.id, viewer.id
        )
        == old.share_token
    )
    assert (
        knowledge_share_service.get_share_link(
            test_db, resource.id, viewer.id
        ).share_token
        == old.share_token
    )


@pytest.mark.parametrize("version", [1, 2, 9])
@pytest.mark.parametrize("has_hash", [True, False])
def test_expired_tokens_and_unknown_versions_fail_closed(test_db, version, has_hash):
    owner = _add_user(test_db, "legacy-expiry-owner")
    task = _add_task(test_db, owner, "legacy-expiry")
    link = _legacy(test_db, task, ResourceType.TASK)
    link.token_version = version
    if not has_hash:
        link.token_hash = None
    link.expires_at = datetime.utcnow() - timedelta(seconds=1)
    test_db.commit()
    with pytest.raises(HTTPException) as error:
        shared_task_service.get_public_shared_task(test_db, link.share_token, owner.id)
    assert error.value.status_code == 400
    if version == 9:
        link.expires_at = datetime.utcnow() + timedelta(days=1)
        test_db.commit()
        with pytest.raises(HTTPException) as error:
            shared_task_service.get_public_shared_task(
                test_db, link.share_token, owner.id
            )
        assert error.value.status_code == 400


@pytest.mark.parametrize("version", [2, 9])
def test_hashless_nonlegacy_record_cannot_use_raw_token_lookup(test_db, version):
    owner = _add_user(test_db, "hashless-nonlegacy-owner")
    team = _add_team(test_db, owner, "hashless-nonlegacy-team")
    link = _legacy(test_db, team, ResourceType.TEAM)
    link.token_hash = None
    link.token_version = version
    test_db.commit()
    assert shared_team_service._find_share_link(test_db, link.share_token) is None
    assert team_share_service._find_share_link(test_db, link.share_token) is None


@pytest.mark.parametrize("legacy", [False, True])
def test_share_cannot_read_an_unlinked_upload_from_the_same_owner(test_db, legacy):
    from app.api.endpoints.adapter.attachments import _validate_share_token_access
    from app.models.subtask_context import SubtaskContext

    owner = _add_user(test_db, "unlinked-share-owner")
    task = _add_task(test_db, owner, "unlinked-share-task")
    link = (
        _legacy(test_db, task, ResourceType.TASK)
        if legacy
        else shared_task_service.create_share_link(test_db, task.id, owner.id)
    )
    context = SubtaskContext(
        user_id=owner.id,
        subtask_id=0,
        context_type="attachment",
        name="private-upload.txt",
        status="ready",
    )
    test_db.add(context)
    test_db.commit()
    assert not _validate_share_token_access(
        test_db, context.id, link.share_token, owner.id
    )
