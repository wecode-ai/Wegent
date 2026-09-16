# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import io
import zipfile

import pytest
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.models.kind import Kind
from app.models.user import User
from app.schemas.resource_library import (
    ResourceLibraryCreateListingRequest,
    ResourceLibraryPublicationUpdateRequest,
)
from app.services.adapters.skill_kinds import skill_kinds_service
from app.services.resource_library_service import resource_library_service


@pytest.fixture
def published_skill(test_db: Session, test_user: User) -> Kind:
    skill = Kind(
        user_id=test_user.id,
        kind="Skill",
        name="metadata-skill",
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Skill",
            "metadata": {"name": "metadata-skill", "namespace": "default"},
            "spec": {
                "description": "Current source description",
                "version": "2.0.0",
                "capability": {
                    "visibility": "public",
                    "publishStatus": "published",
                    "description": "Obsolete marketplace summary",
                    "version": "1.0.0",
                    "tags": ["technical_development"],
                },
            },
            "status": {},
        },
        is_active=True,
    )
    test_db.add(skill)
    test_db.flush()
    resource_library_service._sync_publication_index(test_db, skill)
    test_db.commit()
    return skill


@pytest.mark.parametrize("description", ["Updated source description", None])
def test_historical_skill_listing_uses_current_description(
    test_db: Session,
    test_admin_user: User,
    published_skill: Kind,
    description: str | None,
) -> None:
    published_skill.json["spec"]["description"] = description
    flag_modified(published_skill, "json")
    test_db.commit()

    listing = resource_library_service.get_public_listing(
        test_db, listing_id=published_skill.id, user_id=test_admin_user.id
    )

    assert listing.description == description
    assert (
        published_skill.json["spec"]["capability"]["description"]
        == "Obsolete marketplace summary"
    )


@pytest.mark.parametrize("version, expected", [("2.1.0", "2.1.0"), (None, "1.0.0")])
def test_historical_skill_listing_uses_current_version(
    test_db: Session,
    test_admin_user: User,
    published_skill: Kind,
    version: str | None,
    expected: str,
) -> None:
    published_skill.json["spec"]["version"] = version
    published_skill.json["spec"]["capability"]["version"] = "0.9.0"
    flag_modified(published_skill, "json")
    test_db.commit()

    listing = resource_library_service.get_public_listing(
        test_db, listing_id=published_skill.id, user_id=test_admin_user.id
    )

    assert listing.current_version.version == expected
    assert published_skill.json["spec"]["capability"]["version"] == "0.9.0"


def test_non_skill_listing_keeps_publication_version(
    test_db: Session,
    test_admin_user: User,
    published_skill: Kind,
) -> None:
    published_skill.kind = "Team"
    published_skill.json["kind"] = "Team"
    flag_modified(published_skill, "json")
    test_db.commit()

    listing = resource_library_service.get_public_listing(
        test_db, listing_id=published_skill.id, user_id=test_admin_user.id
    )

    assert listing.current_version.version == "1.0.0"


@pytest.mark.parametrize("resource_type", ["skill", None])
def test_skill_search_ignores_historical_marketplace_description(
    test_db: Session,
    test_admin_user: User,
    published_skill: Kind,
    resource_type: str | None,
) -> None:
    current_results = resource_library_service.list_public(
        test_db,
        user_id=test_admin_user.id,
        resource_type=resource_type,
        keyword="Current source",
        tags=[],
        limit=20,
    ).items
    stale_results = resource_library_service.list_public(
        test_db,
        user_id=test_admin_user.id,
        resource_type=resource_type,
        keyword="Obsolete marketplace",
        tags=[],
        limit=20,
    ).items

    assert [item.id for item in current_results] == [published_skill.id]
    assert current_results[0].description == "Current source description"
    assert stale_results == []


@pytest.mark.parametrize("operation", ["publish", "update"])
def test_sharing_skill_does_not_store_separate_description_and_version(
    test_db: Session,
    test_user: User,
    published_skill: Kind,
    operation: str,
) -> None:
    if operation == "publish":
        listing = resource_library_service.publish(
            test_db,
            current_user=test_user,
            request=ResourceLibraryCreateListingRequest(
                resource_type="skill",
                source_id=published_skill.id,
                display_name=published_skill.name,
                description="Submitted marketplace description",
                version="0.9.0",
                tags=["technical_development"],
            ),
        )
    else:
        listing = resource_library_service.update_publication(
            test_db,
            listing_id=published_skill.id,
            current_user=test_user,
            request=ResourceLibraryPublicationUpdateRequest(
                description="Submitted marketplace description", version="0.9.0"
            ),
        )

    assert listing.description == "Current source description"
    assert listing.current_version.version == "2.0.0"
    assert "description" not in published_skill.json["spec"]["capability"]
    assert "version" not in published_skill.json["spec"]["capability"]


def test_updating_shared_skill_package_updates_marketplace_metadata(
    test_db: Session, test_admin_user: User, published_skill: Kind
) -> None:
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, "w") as package:
        package.writestr(
            "metadata-skill/SKILL.md",
            "---\ndescription: Updated package description\n"
            "version: 3.0.0\n---\nNew instructions\n",
        )

    updated = skill_kinds_service.update_skill(
        test_db,
        skill_id=published_skill.id,
        user_id=published_skill.user_id,
        file_content=archive.getvalue(),
        file_name="metadata-skill.zip",
    )
    listing = resource_library_service.get_public_listing(
        test_db, listing_id=published_skill.id, user_id=test_admin_user.id
    )

    assert updated.spec.description == "Updated package description"
    assert listing.description == updated.spec.description
    assert updated.spec.version == "3.0.0"
    assert listing.current_version.version == updated.spec.version
