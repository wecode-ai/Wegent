# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest
from fastapi import HTTPException

from app.models.resource_library import RESOURCE_LIBRARY_STATUS_ARCHIVED
from app.schemas.resource_library import ResourceLibraryListingCreate


def _create_payload(
    *,
    resource_type: str = "skill",
    source_id: int = 1,
    name: str = "doc-summary",
    display_name: str = "Doc Summary",
    description: str = "Summarizes documents",
    tags: list[str] | None = None,
    version: str = "1.0.0",
) -> ResourceLibraryListingCreate:
    return ResourceLibraryListingCreate(
        resource_type=resource_type,
        source_id=source_id,
        name=name,
        display_name=display_name,
        description=description,
        tags=tags or ["docs"],
        version=version,
        manifest_options={"manifest": {resource_type: {"name": name}}},
    )


def test_create_listing_creates_current_version(test_db, test_user):
    from app.services.resource_library.service import resource_library_service

    created = resource_library_service.create_listing(
        db=test_db,
        user_id=test_user.id,
        payload=_create_payload(
            resource_type="agent",
            source_id=123,
            name="research-agent",
            display_name="Research Agent",
            description="Collects sources",
            tags=["research"],
        ),
    )

    assert created.name == "research-agent"
    assert created.current_version_id is not None


def test_list_published_filters_by_type_and_keyword(test_db, test_user):
    from app.services.resource_library.service import resource_library_service

    resource_library_service.create_listing(
        db=test_db,
        user_id=test_user.id,
        payload=_create_payload(),
    )
    resource_library_service.create_listing(
        db=test_db,
        user_id=test_user.id,
        payload=_create_payload(
            resource_type="agent",
            source_id=2,
            name="research-agent",
            display_name="Research Agent",
            description="Collects sources",
            tags=["research"],
        ),
    )

    items, total = resource_library_service.list_listings(
        db=test_db,
        user_id=test_user.id,
        resource_type="skill",
        keyword="summary",
        skip=0,
        limit=20,
    )

    assert total == 1
    assert items[0].name == "doc-summary"


def test_get_listing_returns_published_listing(test_db, test_user):
    from app.services.resource_library.service import resource_library_service

    created = resource_library_service.create_listing(
        db=test_db,
        user_id=test_user.id,
        payload=_create_payload(),
    )

    found = resource_library_service.get_listing(
        db=test_db,
        listing_id=created.id,
        user_id=test_user.id,
    )

    assert found.id == created.id


def test_archive_listing_hides_listing_from_discovery(test_db, test_user):
    from app.services.resource_library.service import resource_library_service

    created = resource_library_service.create_listing(
        db=test_db,
        user_id=test_user.id,
        payload=_create_payload(),
    )

    archived = resource_library_service.archive_listing(
        db=test_db,
        listing_id=created.id,
        user_id=test_user.id,
    )
    items, total = resource_library_service.list_listings(
        db=test_db,
        user_id=test_user.id,
        resource_type="skill",
        keyword="summary",
        skip=0,
        limit=20,
    )

    assert archived.status == RESOURCE_LIBRARY_STATUS_ARCHIVED
    assert total == 0
    assert items == []


def test_archive_listing_rejects_non_owner(test_db, test_user, test_admin_user):
    from app.services.resource_library.service import resource_library_service

    created = resource_library_service.create_listing(
        db=test_db,
        user_id=test_user.id,
        payload=_create_payload(),
    )

    with pytest.raises(HTTPException) as exc_info:
        resource_library_service.archive_listing(
            db=test_db,
            listing_id=created.id,
            user_id=test_admin_user.id,
        )

    assert exc_info.value.status_code == 403
