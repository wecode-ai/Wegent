# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from app.models.kind import Kind


def test_resource_library_listing_is_stored_as_kind(test_db, test_user):
    listing = Kind(
        user_id=test_user.id,
        kind="ResourceLibraryListing",
        name="research-agent",
        namespace="resource-library",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "ResourceLibraryListing",
            "metadata": {
                "name": "research-agent",
                "namespace": "resource-library",
                "labels": {
                    "resource-library/status": "published",
                    "resource-library/resource-type": "agent",
                    "resource-library/source-kind": "Team",
                    "resource-library/source-kind-id": "101",
                },
            },
            "spec": {
                "resourceType": "agent",
                "sourceKind": "Team",
                "sourceKindId": 101,
                "displayName": "Research Agent",
                "description": "Collects and summarizes source material",
                "tags": ["research", "summary"],
                "version": "1.0.0",
            },
        },
        is_active=True,
    )
    test_db.add(listing)
    test_db.commit()
    test_db.refresh(listing)

    assert listing.id > 0
    assert listing.kind == "ResourceLibraryListing"
    assert listing.json["spec"]["sourceKindId"] == 101
