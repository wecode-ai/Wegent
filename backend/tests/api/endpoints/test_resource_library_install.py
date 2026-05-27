# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import sys
import types

try:
    import magic  # noqa: F401
except ImportError:
    sys.modules.pop("magic", None)

    class _TestMagic:
        def __init__(self, *args, **kwargs):
            pass

        def from_buffer(self, content):
            return "application/octet-stream"

    sys.modules["magic"] = types.SimpleNamespace(Magic=_TestMagic)

from app.models.kind import Kind
from app.models.resource_library import ResourceLibraryInstall, ResourceLibraryVersion
from app.schemas.resource_library import ResourceLibraryListingCreate
from app.services.resource_library.service import resource_library_service


def auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _create_team(
    test_db,
    *,
    user_id: int,
    name: str = "research-agent",
) -> Kind:
    team = Kind(
        user_id=user_id,
        kind="Team",
        name=name,
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Team",
            "metadata": {"name": name, "namespace": "default"},
            "spec": {"members": [], "collaborationModel": "solo"},
        },
        is_active=True,
    )
    test_db.add(team)
    test_db.commit()
    test_db.refresh(team)
    return team


def _create_agent_listing(test_db, *, test_user, team: Kind):
    return resource_library_service.create_listing(
        db=test_db,
        user_id=test_user.id,
        payload=ResourceLibraryListingCreate(
            resource_type="agent",
            source_id=team.id,
            name=team.name,
            display_name="Research Agent",
            description="Collects sources",
            tags=[],
            version="1.0.0",
        ),
    )


def test_install_listing_creates_install_record(
    test_client,
    test_db,
    test_user,
    test_token,
):
    team = _create_team(test_db, user_id=test_user.id)
    listing = _create_agent_listing(test_db, test_user=test_user, team=team)

    response = test_client.post(
        f"/api/resource-library/listings/{listing.id}/install",
        headers=auth_headers(test_token),
        json={"target_namespace": "default"},
    )

    assert response.status_code == 201
    body = response.json()
    assert body["install_status"] == "installed"
    assert body["requires_configuration"] is False
    assert body["installed_reference"]["team_id"] > 0
    assert (
        test_db.query(ResourceLibraryInstall)
        .filter_by(
            listing_id=listing.id,
            user_id=test_user.id,
            install_status="installed",
        )
        .one()
    )


def test_install_listing_rejects_duplicate_install(
    test_client,
    test_db,
    test_user,
    test_token,
):
    team = _create_team(test_db, user_id=test_user.id)
    listing = _create_agent_listing(test_db, test_user=test_user, team=team)

    first_response = test_client.post(
        f"/api/resource-library/listings/{listing.id}/install",
        headers=auth_headers(test_token),
        json={"target_namespace": "default"},
    )
    duplicate_response = test_client.post(
        f"/api/resource-library/listings/{listing.id}/install",
        headers=auth_headers(test_token),
        json={"target_namespace": "default"},
    )

    assert first_response.status_code == 201
    assert duplicate_response.status_code == 409


def test_install_listing_returns_404_when_current_version_missing(
    test_client,
    test_db,
    test_user,
    test_token,
):
    team = _create_team(test_db, user_id=test_user.id)
    listing = _create_agent_listing(test_db, test_user=test_user, team=team)
    version = test_db.get(ResourceLibraryVersion, listing.current_version_id)
    version.is_current = False
    listing.current_version_id = None
    test_db.add(version)
    test_db.add(listing)
    test_db.commit()

    response = test_client.post(
        f"/api/resource-library/listings/{listing.id}/install",
        headers=auth_headers(test_token),
        json={"target_namespace": "default"},
    )

    assert response.status_code == 404


def test_failed_install_records_failure_without_creating_team(
    test_client,
    test_db,
    test_user,
    test_token,
):
    team = _create_team(test_db, user_id=test_user.id)
    listing = _create_agent_listing(test_db, test_user=test_user, team=team)
    version = test_db.get(ResourceLibraryVersion, listing.current_version_id)
    manifest = dict(version.manifest)
    manifest.pop("team")
    version.manifest = manifest
    test_db.add(version)
    test_db.commit()

    response = test_client.post(
        f"/api/resource-library/listings/{listing.id}/install",
        headers=auth_headers(test_token),
        json={"target_namespace": "team-a"},
    )

    failed_install = (
        test_db.query(ResourceLibraryInstall)
        .filter_by(
            listing_id=listing.id,
            user_id=test_user.id,
            install_status="failed",
        )
        .one()
    )
    assert response.status_code == 400
    assert failed_install.error_message
    assert test_db.query(Kind).filter(Kind.namespace == "team-a").count() == 0
