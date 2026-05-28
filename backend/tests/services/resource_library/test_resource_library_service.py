# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from app.schemas.resource_library import ResourceLibraryListingCreate
from app.services.resource_library.service import resource_library_service


def test_create_listing_creates_current_version(test_db, test_user):
    created = resource_library_service.create_listing(
        db=test_db,
        user_id=test_user.id,
        payload=ResourceLibraryListingCreate(
            resource_type="agent",
            source_id=123,
            name="research-agent",
            display_name="Research Agent",
            description="Collects sources",
            tags=["research"],
            version="1.0.0",
            manifest_options={"manifest": {"team": {"name": "research-agent"}}},
        ),
    )

    assert created.name == "research-agent"
    assert created.current_version_id is not None


def test_list_published_filters_by_type_and_keyword(test_db, test_user):
    resource_library_service.create_listing(
        db=test_db,
        user_id=test_user.id,
        payload=ResourceLibraryListingCreate(
            resource_type="skill",
            source_id=1,
            name="doc-summary",
            display_name="Doc Summary",
            description="Summarizes documents",
            tags=["docs"],
            version="1.0.0",
            manifest_options={"manifest": {"skill": {"name": "doc-summary"}}},
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
