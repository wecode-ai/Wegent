# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest
from fastapi import HTTPException

from app.models.kind import Kind
from app.models.resource_library import ResourceLibraryListing, ResourceLibraryVersion
from app.services.resource_library.installers import AgentResourceInstaller


def _create_team(
    test_db,
    *,
    user_id: int,
    name: str = "research-agent",
    namespace: str = "default",
    description: str = "Live source must not be copied",
) -> Kind:
    team = Kind(
        user_id=user_id,
        kind="Team",
        name=name,
        namespace=namespace,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Team",
            "metadata": {
                "name": name,
                "namespace": namespace,
                "displayName": "Research Agent",
            },
            "spec": {
                "members": [],
                "collaborationModel": "solo",
                "description": description,
            },
        },
        is_active=True,
    )
    test_db.add(team)
    test_db.commit()
    test_db.refresh(team)
    return team


def _create_agent_listing_and_version(
    test_db,
    *,
    test_user,
    source_team: Kind,
    team_snapshot: dict | None,
) -> tuple[ResourceLibraryListing, ResourceLibraryVersion]:
    listing = ResourceLibraryListing(
        resource_type="agent",
        name=source_team.name,
        display_name="Research Agent",
        publisher_user_id=test_user.id,
        status="published",
        tags=[],
    )
    test_db.add(listing)
    test_db.commit()
    test_db.refresh(listing)

    manifest = {
        "resource_type": "agent",
        "source": {
            "kind_id": source_team.id,
            "namespace": source_team.namespace,
            "name": source_team.name,
        },
    }
    if team_snapshot is not None:
        manifest["team"] = team_snapshot

    version = ResourceLibraryVersion(
        listing_id=listing.id,
        version="1.0.0",
        manifest=manifest,
        source_kind_id=source_team.id,
        is_current=True,
    )
    test_db.add(version)
    test_db.commit()
    test_db.refresh(version)
    return listing, version


def test_agent_installer_copies_team_snapshot_and_handles_name_conflict(
    test_db,
    test_user,
):
    source_team = _create_team(test_db, user_id=test_user.id)
    snapshot = {
        **source_team.json,
        "metadata": {
            **source_team.json["metadata"],
            "name": "research-agent",
            "namespace": "source",
        },
        "spec": {
            **source_team.json["spec"],
            "description": "Snapshot description",
        },
    }
    listing, version = _create_agent_listing_and_version(
        test_db,
        test_user=test_user,
        source_team=source_team,
        team_snapshot=snapshot,
    )

    result = AgentResourceInstaller().install(
        db=test_db,
        user_id=test_user.id,
        listing=listing,
        version=version,
        target_namespace="default",
        options={},
    )

    copied_team = test_db.get(Kind, result.installed_kind_id)
    assert copied_team.kind == "Team"
    assert copied_team.name == "research-agent-2"
    assert copied_team.namespace == "default"
    assert copied_team.user_id == test_user.id
    assert copied_team.json["metadata"]["name"] == "research-agent-2"
    assert copied_team.json["metadata"]["namespace"] == "default"
    assert copied_team.json["spec"]["description"] == "Snapshot description"
    assert result.installed_reference == {
        "team_id": copied_team.id,
        "namespace": "default",
        "name": "research-agent-2",
    }


def test_agent_installer_fails_without_team_snapshot(test_db, test_user):
    source_team = _create_team(test_db, user_id=test_user.id)
    listing, version = _create_agent_listing_and_version(
        test_db,
        test_user=test_user,
        source_team=source_team,
        team_snapshot=None,
    )

    with pytest.raises(HTTPException) as exc_info:
        AgentResourceInstaller().install(
            db=test_db,
            user_id=test_user.id,
            listing=listing,
            version=version,
            target_namespace="team-a",
            options={},
        )

    assert exc_info.value.status_code == 400
    assert test_db.query(Kind).filter(Kind.namespace == "team-a").count() == 0
