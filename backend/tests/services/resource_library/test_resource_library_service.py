# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest
from fastapi import HTTPException

from app.models.kind import Kind
from app.models.resource_library import (
    RESOURCE_LIBRARY_STATUS_ARCHIVED,
    ResourceLibraryVersion,
)
from app.schemas.resource_library import ResourceLibraryListingCreate


def _create_kind(
    test_db,
    *,
    user_id: int,
    kind: str = "Skill",
    name: str = "doc-summary",
    namespace: str = "default",
) -> Kind:
    source = Kind(
        user_id=user_id,
        kind=kind,
        name=name,
        namespace=namespace,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": kind,
            "metadata": {"name": name, "namespace": namespace},
            "spec": {"description": f"{kind} {name}"},
        },
        is_active=True,
    )
    test_db.add(source)
    test_db.commit()
    test_db.refresh(source)
    return source


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
        manifest_options={"manifest": {"client_supplied": True}},
    )


def test_create_listing_creates_current_version(test_db, test_user):
    from app.services.resource_library.service import resource_library_service

    source = _create_kind(
        test_db,
        user_id=test_user.id,
        kind="Team",
        name="research-agent",
    )

    created = resource_library_service.create_listing(
        db=test_db,
        user_id=test_user.id,
        payload=_create_payload(
            resource_type="agent",
            source_id=source.id,
            name="research-agent",
            display_name="Research Agent",
            description="Collects sources",
            tags=["research"],
        ),
    )

    assert created.name == "research-agent"
    assert created.current_version_id is not None
    version = test_db.get(ResourceLibraryVersion, created.current_version_id)
    assert version.source_kind_id == source.id
    assert version.source_binary_id is None
    assert version.manifest == {
        "resource_type": "agent",
        "team": source.json,
        "source": {
            "kind_id": source.id,
            "name": "research-agent",
            "namespace": "default",
        },
    }
    assert "client_supplied" not in version.manifest


def test_list_published_filters_by_type_and_keyword(test_db, test_user):
    from app.services.resource_library.service import resource_library_service

    skill_source = _create_kind(test_db, user_id=test_user.id)
    agent_source = _create_kind(
        test_db,
        user_id=test_user.id,
        kind="Team",
        name="research-agent",
    )

    resource_library_service.create_listing(
        db=test_db,
        user_id=test_user.id,
        payload=_create_payload(source_id=skill_source.id),
    )
    resource_library_service.create_listing(
        db=test_db,
        user_id=test_user.id,
        payload=_create_payload(
            resource_type="agent",
            source_id=agent_source.id,
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

    source = _create_kind(test_db, user_id=test_user.id)
    created = resource_library_service.create_listing(
        db=test_db,
        user_id=test_user.id,
        payload=_create_payload(source_id=source.id),
    )

    found = resource_library_service.get_listing(
        db=test_db,
        listing_id=created.id,
        user_id=test_user.id,
    )

    assert found.id == created.id


def test_archive_listing_hides_listing_from_discovery(test_db, test_user):
    from app.services.resource_library.service import resource_library_service

    source = _create_kind(test_db, user_id=test_user.id)
    created = resource_library_service.create_listing(
        db=test_db,
        user_id=test_user.id,
        payload=_create_payload(source_id=source.id),
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

    source = _create_kind(test_db, user_id=test_user.id)
    created = resource_library_service.create_listing(
        db=test_db,
        user_id=test_user.id,
        payload=_create_payload(source_id=source.id),
    )

    with pytest.raises(HTTPException) as exc_info:
        resource_library_service.archive_listing(
            db=test_db,
            listing_id=created.id,
            user_id=test_admin_user.id,
        )

    assert exc_info.value.status_code == 403


def test_create_listing_rejects_missing_source_resource(test_db, test_user):
    from app.services.resource_library.service import resource_library_service

    with pytest.raises(HTTPException) as exc_info:
        resource_library_service.create_listing(
            db=test_db,
            user_id=test_user.id,
            payload=_create_payload(source_id=99999),
        )

    assert exc_info.value.status_code == 404


def test_create_listing_rejects_source_owned_by_another_user(
    test_db,
    test_user,
    test_admin_user,
):
    from app.services.resource_library.service import resource_library_service

    source = _create_kind(test_db, user_id=test_admin_user.id)

    with pytest.raises(HTTPException) as exc_info:
        resource_library_service.create_listing(
            db=test_db,
            user_id=test_user.id,
            payload=_create_payload(source_id=source.id),
        )

    assert exc_info.value.status_code == 404


def test_create_listing_returns_conflict_for_duplicate_owner_name_and_keeps_session(
    test_db,
    test_user,
):
    from app.services.resource_library.service import resource_library_service

    source = _create_kind(test_db, user_id=test_user.id, name="doc-summary")
    second_source = _create_kind(test_db, user_id=test_user.id, name="doc-summary-v2")
    resource_library_service.create_listing(
        db=test_db,
        user_id=test_user.id,
        payload=_create_payload(source_id=source.id),
    )

    with pytest.raises(HTTPException) as exc_info:
        resource_library_service.create_listing(
            db=test_db,
            user_id=test_user.id,
            payload=_create_payload(source_id=second_source.id),
        )

    assert exc_info.value.status_code == 409
    assert exc_info.value.detail == "Resource listing already exists"
    assert test_db.query(Kind).count() >= 2


def test_create_listing_allows_mcp_minimal_server_manifest(test_db, test_user):
    from app.services.resource_library.service import resource_library_service

    created = resource_library_service.create_listing(
        db=test_db,
        user_id=test_user.id,
        payload=_create_payload(
            resource_type="mcp",
            source_id=42,
            name="browser-tools",
            display_name="Browser Tools",
        ),
    )

    version = test_db.get(ResourceLibraryVersion, created.current_version_id)
    assert version.source_kind_id is None
    assert version.source_binary_id is None
    assert version.manifest == {
        "resource_type": "mcp",
        "server_name": "mcp-42",
        "server_config_template": {"type": "streamable-http", "url": ""},
        "required_fields": ["url"],
    }
