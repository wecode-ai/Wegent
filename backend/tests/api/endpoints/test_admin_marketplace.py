# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from app.models.kind import Kind
from app.models.marketplace_resource import MarketplaceResource


def _headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _resource(
    test_db,
    *,
    user_id: int,
    kind: str,
    name: str,
    recommendation_score: int = 0,
) -> Kind:
    capability = (
        {"marketplace": {"recommendationScore": recommendation_score}}
        if user_id == 0
        else {}
    )
    resource = Kind(
        user_id=user_id,
        kind=kind,
        name=name,
        namespace="default",
        json={
            "kind": kind,
            "metadata": {"name": name, "displayName": f"{name} display"},
            "spec": {
                "displayName": f"{name} display",
                "description": f"{name} description",
                "members": [],
                "capability": capability,
            },
        },
        is_active=True,
    )
    test_db.add(resource)
    test_db.commit()
    test_db.refresh(resource)
    return resource


def test_admin_manages_agent_and_skill_marketplace_curation(
    test_client,
    test_db,
    test_admin_token,
    test_token,
    test_user,
):
    agent = _resource(
        test_db,
        user_id=0,
        kind="Team",
        name="market-admin-agent",
    )
    skill = _resource(
        test_db,
        user_id=test_user.id,
        kind="Skill",
        name="market-admin-skill",
    )
    test_db.add(
        MarketplaceResource(
            kind_id=skill.id,
            owner_user_id=test_user.id,
            resource_type="skill",
        )
    )
    test_db.commit()

    agents = test_client.get(
        "/api/admin/marketplace-resources?resource_type=agent",
        headers=_headers(test_admin_token),
    )
    skills = test_client.get(
        "/api/admin/marketplace-resources?resource_type=skill",
        headers=_headers(test_admin_token),
    )
    forbidden = test_client.put(
        f"/api/admin/marketplace-resources/{agent.id}",
        json={"recommendation_score": 80},
        headers=_headers(test_token),
    )
    updated = test_client.put(
        f"/api/admin/marketplace-resources/{agent.id}",
        json={
            "recommendation_score": 90,
            "example_conversations": [
                {
                    "title": "Example conversation",
                    "url": "https://example.com/shared/conversation",
                },
                {
                    "title": "Second example",
                    "url": "https://example.com/shared/second",
                },
            ],
        },
        headers=_headers(test_admin_token),
    )
    updated_skill = test_client.put(
        f"/api/admin/marketplace-resources/{skill.id}",
        json={"recommendation_score": 80},
        headers=_headers(test_admin_token),
    )
    featured = test_client.get(
        "/api/resource-library/listings"
        "?resource_type=agent&featured_only=true&keyword=market-admin-agent",
        headers=_headers(test_token),
    )
    featured_skill = test_client.get(
        "/api/resource-library/listings"
        "?resource_type=skill&featured_only=true&keyword=market-admin-skill",
        headers=_headers(test_token),
    )

    assert agents.status_code == 200
    assert [item["id"] for item in agents.json()["items"]] == [agent.id]
    assert skills.status_code == 200
    assert [item["id"] for item in skills.json()["items"]] == [skill.id]
    assert forbidden.status_code == 403
    assert updated.status_code == 200
    assert updated.json()["recommendation_score"] == 90
    assert [item["title"] for item in updated.json()["example_conversations"]] == [
        "Example conversation",
        "Second example",
    ]
    assert updated_skill.status_code == 200
    assert updated_skill.json()["recommendation_score"] == 80
    assert test_db.get(MarketplaceResource, skill.id).recommendation_score == 80
    assert [item["id"] for item in featured.json()["items"]] == [agent.id]
    assert len(featured.json()["items"][0]["example_conversations"]) == 2
    assert [item["id"] for item in featured_skill.json()["items"]] == [skill.id]


def test_new_system_public_agent_is_featured_by_default(
    test_client,
    test_db,
    test_admin_token,
):
    created = test_client.post(
        "/api/admin/public-teams",
        json={
            "name": "default-featured-system-agent",
            "namespace": "default",
            "json": {
                "kind": "Team",
                "metadata": {
                    "name": "default-featured-system-agent",
                    "displayName": "Default Featured System Agent",
                },
                "spec": {
                    "members": [],
                    "collaborationModel": "solo",
                },
            },
        },
        headers=_headers(test_admin_token),
    )

    assert created.status_code == 201
    agent = test_db.get(Kind, created.json()["id"])
    assert agent is not None
    marketplace = (
        agent.json.get("spec", {}).get("capability", {}).get("marketplace", {})
    )
    assert "recommendationScore" not in marketplace
