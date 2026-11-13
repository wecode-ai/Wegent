# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Readers can inspect authorization objects without acquiring management."""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.api.endpoints.share import router
from app.core.security import get_current_user
from app.models.kind import Kind
from app.models.resource_member import ResourceMember, ResourceRole
from app.models.share_link import ShareLink
from app.models.task import TaskResource
from app.models.user import User
from app.schemas.knowledge import KnowledgeBaseCreate
from app.schemas.namespace import GroupRole
from app.services.knowledge.knowledge_service import KnowledgeService
from tests.services.knowledge.test_namespace_knowledge_permissions import (
    _add_kb_member,
    _add_member,
    _create_namespace,
    _create_user,
)


def _member_client(test_db: Session, user: User) -> TestClient:
    app = FastAPI()
    app.include_router(router, prefix="/share")
    app.dependency_overrides[get_db] = lambda: test_db
    app.dependency_overrides[get_current_user] = lambda: user
    return TestClient(app)


@pytest.mark.unit
def test_reader_sees_all_grants_but_cannot_edit(test_db: Session) -> None:
    owner = _create_user(test_db, "grant-owner")
    reader = _create_user(test_db, "grant-reader")
    other = _create_user(test_db, "grant-other")
    outsider = _create_user(test_db, "grant-outsider")
    group = _create_namespace(test_db, owner, "grant-group")
    _add_member(test_db, group, owner, GroupRole.Owner, owner.id)
    _add_member(test_db, group, reader, GroupRole.Reporter, owner.id)
    kb_id = KnowledgeService.create_knowledge_base(
        test_db, owner.id, KnowledgeBaseCreate(name="grants", namespace=group.name)
    )
    member = _add_kb_member(test_db, kb_id, other, ResourceRole.Reporter, owner.id)
    app = FastAPI()
    app.include_router(router, prefix="/share")
    app.dependency_overrides[get_db] = lambda: test_db
    app.dependency_overrides[get_current_user] = lambda: reader
    with TestClient(app) as client:
        path = f"/share/KnowledgeBase/{kb_id}/members"
        response = client.get(path)
        assert response.status_code == 200, response.text
        data = response.json()
        assert data["creator"]["display_name"] == owner.user_name
        assert data["creator"]["user_id"] == owner.id
        assert data["inherited_sources"] == [
            {
                "source_type": "group_membership",
                "entity_type": "namespace",
                "entity_id": str(group.id),
                "display_name": group.display_name or group.name,
                "role": None,
            }
        ]
        assert {row["id"] for row in data["members"]} == {member.id}
        assert client.get(f"/share/KnowledgeBase/{kb_id}/requests").status_code == 403
        denied = client.put(f"{path}/{member.id}", json={"role": "Developer"})
        assert denied.status_code == 403, denied.text
        assert client.delete(f"{path}/{member.id}").status_code == 403
        assert (
            client.post(
                path, json={"user_id": outsider.id, "role": "Reporter"}
            ).status_code
            == 403
        )
        unchanged = client.get(path).json()
        assert unchanged["members"][0]["role"] == "Reporter"
        app.dependency_overrides[get_current_user] = lambda: outsider
        assert client.get(path).status_code == 404
        app.dependency_overrides[get_current_user] = lambda: owner
        updated = client.put(f"{path}/{member.id}", json={"role": "Developer"})
        assert updated.status_code == 200, updated.text
        assert updated.json()["role"] == "Developer"


@pytest.mark.unit
def test_members_obey_direct_access_requirement_and_revocation(
    test_db: Session,
) -> None:
    owner = _create_user(test_db, "direct-owner")
    reader = _create_user(test_db, "direct-reader")
    kb_id = KnowledgeService.create_knowledge_base(
        test_db, owner.id, KnowledgeBaseCreate(name="direct", namespace="default")
    )
    member = _add_kb_member(test_db, kb_id, reader, ResourceRole.Reporter, owner.id)
    kb = test_db.get(Kind, kb_id)
    with _member_client(test_db, reader) as client:
        path = f"/share/KnowledgeBase/{kb_id}/members"
        assert client.get(path).status_code == 200
        kb.json = {
            **kb.json,
            "spec": {**kb.json["spec"], "directAccessRequirement": "edit"},
        }
        test_db.commit()
        assert client.get(path).status_code == 404
        member.set_role("Developer")
        test_db.commit()
        assert client.get(path).status_code == 200
        member.status = "rejected"
        test_db.commit()
        assert client.get(path).status_code == 404


@pytest.mark.unit
def test_members_exclude_pending_requests_and_share_secrets(test_db: Session) -> None:
    owner = _create_user(test_db, "safe-owner")
    reader = _create_user(test_db, "safe-reader")
    pending = _create_user(test_db, "safe-pending")
    kb_id = KnowledgeService.create_knowledge_base(
        test_db, owner.id, KnowledgeBaseCreate(name="safe", namespace="default")
    )
    approved = _add_kb_member(test_db, kb_id, reader, ResourceRole.Reporter, owner.id)
    request = _add_kb_member(
        test_db, kb_id, pending, ResourceRole.Developer, owner.id, status="pending"
    )
    link = ShareLink(
        resource_type="KnowledgeBase",
        resource_id=kb_id,
        created_by_user_id=owner.id,
        share_token="opaque-test-secret",
        token_hash="test-hash-secret",
    )
    test_db.add(link)
    test_db.flush()
    approved.share_link_id = link.id
    approved.invited_by_user_id = 0
    test_db.commit()

    with _member_client(test_db, reader) as client:
        response = client.get(f"/share/KnowledgeBase/{kb_id}/members")
        assert response.status_code == 200, response.text
        data = response.json()
        assert data["total"] == 1
        assert [row["id"] for row in data["members"]] == [approved.id]
        assert data["members"][0]["source_type"] == "share_link"
        for secret in (
            link.share_token,
            link.token_hash,
            pending.email,
            pending.user_name,
        ):
            assert secret not in response.text
        for key in (
            "share_token",
            "token_hash",
            "share_link_id",
            "requests",
            "pending",
        ):
            assert f'"{key}"' not in response.text
        assert client.get(f"/share/KnowledgeBase/{kb_id}/requests").status_code == 403
        assert (
            client.post(
                f"/share/KnowledgeBase/{kb_id}/requests/{request.id}/review",
                json={"approved": True, "role": "Developer"},
            ).status_code
            == 403
        )
    with _member_client(test_db, owner) as client:
        requests = client.get(f"/share/KnowledgeBase/{kb_id}/requests")
        assert requests.status_code == 200, requests.text
        assert [row["id"] for row in requests.json()["requests"]] == [request.id]


@pytest.mark.unit
@pytest.mark.parametrize("state", ["missing", "inactive"])
def test_unavailable_libraries_do_not_return_authorization_context(
    test_db: Session, state: str
) -> None:
    owner = _create_user(test_db, "unavailable-owner")
    kb_id = KnowledgeService.create_knowledge_base(
        test_db, owner.id, KnowledgeBaseCreate(name="unavailable", namespace="default")
    )
    kb = test_db.get(Kind, kb_id)
    if state == "missing":
        test_db.delete(kb)
    else:
        kb.is_active = False
    test_db.commit()
    with _member_client(test_db, owner) as client:
        response = client.get(f"/share/KnowledgeBase/{kb_id}/members")
    assert response.status_code == 404
    assert "creator" not in response.json()
    assert "inherited_sources" not in response.json()


@pytest.mark.unit
@pytest.mark.parametrize("state", ["missing", "inactive"])
def test_unavailable_namespace_does_not_invent_an_inherited_rule(
    test_db: Session, state: str
) -> None:
    owner = _create_user(test_db, "namespace-owner")
    namespace = _create_namespace(test_db, owner, "namespace-context")
    _add_member(test_db, namespace, owner, GroupRole.Owner, owner.id)
    kb_id = KnowledgeService.create_knowledge_base(
        test_db,
        owner.id,
        KnowledgeBaseCreate(name="namespace", namespace=namespace.name),
    )
    if state == "missing":
        test_db.delete(namespace)
    else:
        namespace.is_active = False
    test_db.commit()
    with _member_client(test_db, owner) as client:
        response = client.get(f"/share/KnowledgeBase/{kb_id}/members")
    assert response.status_code == 200, response.text
    assert response.json()["inherited_sources"] == []


@pytest.mark.unit
def test_missing_creator_keeps_historical_identity_without_a_user_record(
    test_db: Session,
) -> None:
    owner = _create_user(test_db, "historical-owner")
    reader = _create_user(test_db, "historical-reader")
    kb_id = KnowledgeService.create_knowledge_base(
        test_db, owner.id, KnowledgeBaseCreate(name="historical", namespace="default")
    )
    _add_kb_member(test_db, kb_id, reader, ResourceRole.Reporter, owner.id)
    kb = test_db.get(Kind, kb_id)
    kb.user_id = 987654321
    test_db.commit()
    with _member_client(test_db, reader) as client:
        response = client.get(f"/share/KnowledgeBase/{kb_id}/members")
    assert response.status_code == 200, response.text
    assert response.json()["creator"] == {
        "user_id": 987654321,
        "display_name": "987654321",
    }


@pytest.mark.unit
@pytest.mark.parametrize("resource_type", ["Team", "Task"])
def test_other_resource_members_keep_the_original_response(
    test_db: Session, resource_type: str
) -> None:
    owner = _create_user(test_db, "team-grant-owner")
    model = Kind if resource_type == "Team" else TaskResource
    resource = model(
        user_id=owner.id,
        kind=resource_type,
        name="other-resource",
        namespace="default",
        json={},
    )
    test_db.add(resource)
    test_db.commit()
    with _member_client(test_db, owner) as client:
        response = client.get(f"/share/{resource_type}/{resource.id}/members")
    assert response.status_code == 200, response.text
    assert response.json() == {"members": [], "total": 0}


@pytest.mark.unit
def test_approved_objects_are_complete_and_identity_deduplicated(
    test_db: Session,
) -> None:
    owner = _create_user(test_db, "complete-owner")
    kb_id = KnowledgeService.create_knowledge_base(
        test_db, owner.id, KnowledgeBaseCreate(name="complete", namespace="default")
    )
    for index in range(105):
        test_db.add(
            ResourceMember(
                resource_type="KnowledgeBase",
                resource_id=kb_id,
                entity_type="namespace",
                entity_id=str(1000 + index),
                entity_display_name="Same display name",
                role="Reporter",
                status="approved",
                invited_by_user_id=owner.id,
            )
        )
    _add_kb_member(test_db, kb_id, owner, ResourceRole.Owner, owner.id)
    _add_kb_member(
        test_db,
        kb_id,
        owner,
        ResourceRole.Owner,
        owner.id,
        resource_type="KNOWLEDGE_BASE",
        status="APPROVED",
    )
    with _member_client(test_db, owner) as client:
        response = client.get(f"/share/KnowledgeBase/{kb_id}/members")
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["total"] == len(data["members"]) == 106
    namespaces = [row for row in data["members"] if row["entity_type"] == "namespace"]
    assert {row["entity_id"] for row in namespaces} == {
        str(1000 + index) for index in range(105)
    }


@pytest.mark.unit
@pytest.mark.parametrize("organization", [False, True])
def test_creator_and_organization_rules_do_not_require_explicit_shares(
    test_db: Session, organization: bool
) -> None:
    owner = _create_user(test_db, "context-owner", role="admin")
    namespace = "default"
    if organization:
        group = _create_namespace(
            test_db, owner, "context-company", level="organization"
        )
        namespace = group.name
    kb_id = KnowledgeService.create_knowledge_base(
        test_db, owner.id, KnowledgeBaseCreate(name="context", namespace=namespace)
    )
    app = FastAPI()
    app.include_router(router, prefix="/share")
    app.dependency_overrides[get_db] = lambda: test_db
    app.dependency_overrides[get_current_user] = lambda: owner
    with TestClient(app) as client:
        data = client.get(f"/share/KnowledgeBase/{kb_id}/members").json()
    assert data["creator"]["user_id"] == owner.id
    assert data["members"] == []
    assert data["total"] == 0
    if organization:
        assert data["inherited_sources"][0]["source_type"] == "organization"
        assert data["inherited_sources"][0]["entity_type"] == "organization"
    else:
        assert data["inherited_sources"] == []
