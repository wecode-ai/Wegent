# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from sqlalchemy.orm import Session

from app.core.security import create_access_token, get_password_hash
from app.models.kind import Kind
from app.models.resource_member import MemberStatus, ResourceMember
from app.models.share_link import ResourceType
from app.models.user import User


def auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def create_team(test_db: Session, *, user_id: int, name: str) -> Kind:
    team = Kind(
        user_id=user_id,
        kind="Team",
        name=name,
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Team",
            "metadata": {
                "name": name,
                "namespace": "default",
                "description": "Reusable agent",
            },
            "spec": {"members": [], "collaborationModel": "solo"},
        },
        is_active=True,
    )
    test_db.add(team)
    test_db.commit()
    test_db.refresh(team)
    return team


def create_user_token(test_db: Session, name: str) -> tuple[User, str]:
    user = User(
        user_name=name,
        password_hash=get_password_hash("password123"),
        email=f"{name}@example.com",
        is_active=True,
    )
    test_db.add(user)
    test_db.commit()
    test_db.refresh(user)
    return user, create_access_token(data={"sub": user.user_name})


def test_create_and_list_resource_library_listing(
    test_client, test_db, test_user, test_token
):
    source_team = create_team(test_db, user_id=test_user.id, name="doc-agent")

    create_response = test_client.post(
        "/api/resource-library/listings",
        headers=auth_headers(test_token),
        json={
            "resource_type": "agent",
            "source_id": source_team.id,
            "name": "doc-agent",
            "display_name": "Doc Agent",
            "description": "Summarizes documents",
            "tags": ["docs"],
            "version": "1.0.0",
        },
    )

    assert create_response.status_code == 201
    listing_id = create_response.json()["id"]

    list_response = test_client.get(
        "/api/resource-library/listings?resource_type=agent&keyword=doc",
        headers=auth_headers(test_token),
    )

    assert list_response.status_code == 200
    body = list_response.json()
    assert body["total"] == 1
    assert body["items"][0]["id"] == listing_id
    assert body["items"][0]["current_version"]["version"] == "1.0.0"


def test_install_resource_library_listing_accepts_team_share(
    test_client, test_db, test_user, test_token
):
    source_team = create_team(test_db, user_id=test_user.id, name="installable-agent")
    create_response = test_client.post(
        "/api/resource-library/listings",
        headers=auth_headers(test_token),
        json={
            "resource_type": "agent",
            "source_id": source_team.id,
            "name": "installable-agent",
            "display_name": "Installable Agent",
            "description": "Shared agent",
            "tags": ["agent"],
            "version": "1.0.0",
        },
    )
    listing_id = create_response.json()["id"]
    consumer, consumer_token = create_user_token(test_db, "consumer")

    install_response = test_client.post(
        f"/api/resource-library/listings/{listing_id}/install",
        headers=auth_headers(consumer_token),
        json={"target_namespace": "default"},
    )

    assert install_response.status_code == 200
    assert install_response.json()["listing_id"] == listing_id
    assert install_response.json()["install_status"] == "installed"
    assert install_response.json()["installed_kind_id"] == source_team.id

    shared_member = (
        test_db.query(ResourceMember)
        .filter(
            ResourceMember.resource_type == ResourceType.TEAM,
            ResourceMember.resource_id == source_team.id,
            ResourceMember.entity_type == "user",
            ResourceMember.entity_id == str(consumer.id),
            ResourceMember.status == MemberStatus.APPROVED,
        )
        .first()
    )
    copied_team = (
        test_db.query(Kind)
        .filter(
            Kind.kind == "Team",
            Kind.user_id == consumer.id,
            Kind.name == source_team.name,
            Kind.is_active == True,
        )
        .first()
    )

    assert shared_member is not None
    assert copied_team is None


def test_list_my_published_and_archive_resource_library_listing(
    test_client, test_db, test_user, test_token
):
    source_team = create_team(test_db, user_id=test_user.id, name="published-agent")
    create_response = test_client.post(
        "/api/resource-library/listings",
        headers=auth_headers(test_token),
        json={
            "resource_type": "agent",
            "source_id": source_team.id,
            "name": "published-agent",
            "display_name": "Published Agent",
            "description": "Reusable agent",
            "tags": ["agent"],
            "version": "1.0.0",
        },
    )
    listing_id = create_response.json()["id"]

    published_response = test_client.get(
        "/api/resource-library/users/me/published?resource_type=agent",
        headers=auth_headers(test_token),
    )

    assert published_response.status_code == 200
    assert published_response.json()["total"] == 1
    assert published_response.json()["items"][0]["id"] == listing_id

    archive_response = test_client.post(
        f"/api/resource-library/listings/{listing_id}/archive",
        headers=auth_headers(test_token),
    )

    assert archive_response.status_code == 200
    assert archive_response.json()["status"] == "archived"


def test_list_my_installs(test_client, test_db, test_user, test_token):
    source_team = create_team(test_db, user_id=test_user.id, name="docs-agent")
    create_response = test_client.post(
        "/api/resource-library/listings",
        headers=auth_headers(test_token),
        json={
            "resource_type": "agent",
            "source_id": source_team.id,
            "name": "docs-agent",
            "display_name": "Docs Agent",
            "description": "Documentation agent",
            "tags": ["docs"],
            "version": "1.0.0",
        },
    )
    listing_id = create_response.json()["id"]
    _, consumer_token = create_user_token(test_db, "install-list-user")
    test_client.post(
        f"/api/resource-library/listings/{listing_id}/install",
        headers=auth_headers(consumer_token),
        json={},
    )

    installs_response = test_client.get(
        "/api/resource-library/users/me/installs?resource_type=agent",
        headers=auth_headers(consumer_token),
    )

    assert installs_response.status_code == 200
    assert installs_response.json()["total"] == 1
    assert installs_response.json()["items"][0]["listing_id"] == listing_id
