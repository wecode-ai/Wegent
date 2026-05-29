# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from app.core.security import get_password_hash
from app.models.kind import Kind
from app.models.resource_member import MemberStatus, ResourceMember
from app.models.share_link import ResourceType
from app.models.user import User
from app.schemas.resource_library import ResourceLibraryListingCreate
from app.services.resource_library.service import resource_library_service


def create_team(test_db, *, user_id: int, name: str = "research-agent") -> Kind:
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
                "description": "Collects sources",
            },
            "spec": {"members": [], "collaborationModel": "solo"},
        },
        is_active=True,
    )
    test_db.add(team)
    test_db.commit()
    test_db.refresh(team)
    return team


def create_user(test_db, name: str) -> User:
    user = User(
        user_name=name,
        password_hash=get_password_hash("password123"),
        email=f"{name}@example.com",
        is_active=True,
    )
    test_db.add(user)
    test_db.commit()
    test_db.refresh(user)
    return user


def test_create_listing_creates_kind_listing_that_points_to_source_team(
    test_db, test_user
):
    source_team = create_team(test_db, user_id=test_user.id)

    created = resource_library_service.create_listing(
        db=test_db,
        user_id=test_user.id,
        payload=ResourceLibraryListingCreate(
            resource_type="agent",
            source_id=source_team.id,
            name="research-agent",
            display_name="Research Agent",
            description="Collects sources",
            tags=["research"],
            version="1.0.0",
        ),
    )

    assert created.kind == "ResourceLibraryListing"
    assert created.name == "research-agent"
    assert created.user_id == test_user.id
    assert created.json["spec"]["sourceKindId"] == source_team.id
    assert created.json["spec"]["resourceType"] == "agent"


def test_list_published_filters_by_type_and_keyword(test_db, test_user):
    source_team = create_team(test_db, user_id=test_user.id, name="doc-summary")
    resource_library_service.create_listing(
        db=test_db,
        user_id=test_user.id,
        payload=ResourceLibraryListingCreate(
            resource_type="agent",
            source_id=source_team.id,
            name="doc-summary",
            display_name="Doc Summary",
            description="Summarizes documents",
            tags=["docs"],
            version="1.0.0",
        ),
    )

    items, total = resource_library_service.list_listings(
        db=test_db,
        user_id=test_user.id,
        resource_type="agent",
        keyword="summary",
        skip=0,
        limit=20,
    )

    assert total == 1
    assert items[0].name == "doc-summary"


def test_install_listing_accepts_share_without_copying_source_team(test_db, test_user):
    source_team = create_team(test_db, user_id=test_user.id, name="shared-agent")
    listing = resource_library_service.create_listing(
        db=test_db,
        user_id=test_user.id,
        payload=ResourceLibraryListingCreate(
            resource_type="agent",
            source_id=source_team.id,
            name="shared-agent",
            display_name="Shared Agent",
            description="Shared agent description",
            tags=["agent"],
            version="1.0.0",
        ),
    )
    consumer = create_user(test_db, "consumer")

    install = resource_library_service.install_listing(
        db=test_db,
        listing_id=listing.id,
        user_id=consumer.id,
    )

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
    assert install.id == shared_member.id
    assert install.listing_id == listing.id
    assert install.installed_kind_id == source_team.id
