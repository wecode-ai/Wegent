# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from app.models.kind import Kind
from app.models.resource_member import ResourceMember
from app.services.resource_library_service import resource_library_service


def _headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _system_skill(test_db, name: str = "api-system-skill") -> Kind:
    skill = Kind(
        user_id=0,
        kind="Skill",
        name=name,
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Skill",
            "metadata": {"name": name, "namespace": "default"},
            "spec": {
                "displayName": "API System Skill",
                "description": "API test skill",
                "version": "1.0.0",
            },
        },
        is_active=True,
    )
    test_db.add(skill)
    test_db.commit()
    test_db.refresh(skill)
    return skill


def test_discover_install_and_list_personal_installs(test_client, test_db, test_token):
    skill = _system_skill(test_db)

    discover = test_client.get(
        "/api/resource-library/listings?resource_type=skill",
        headers=_headers(test_token),
    )
    install = test_client.post(
        f"/api/resource-library/listings/{skill.id}/install",
        json={"target_namespace": "default"},
        headers=_headers(test_token),
    )
    installed = test_client.get(
        "/api/resource-library/users/me/installs?resource_type=skill",
        headers=_headers(test_token),
    )

    assert discover.status_code == 200
    assert [item["id"] for item in discover.json()["items"]] == [skill.id]
    assert install.status_code == 200
    assert install.json()["installed_reference"]["skill_id"] == skill.id
    assert installed.status_code == 200
    assert [item["listing_id"] for item in installed.json()["items"]] == [skill.id]


def test_publish_and_change_publication_rules(
    test_client, test_db, test_token, test_user
):
    skill = _system_skill(test_db, name="owned-api-skill")
    skill.user_id = test_user.id
    test_db.commit()

    published = test_client.post(
        "/api/resource-library/listings",
        json={
            "resource_type": "skill",
            "source_id": skill.id,
            "name": "owned-api-skill",
            "display_name": "Owned API Skill",
            "tags": ["api"],
            "version": "1.0.0",
        },
        headers=_headers(test_token),
    )
    updated = test_client.put(
        f"/api/resource-library/listings/{skill.id}/publication",
        json={
            "allow_group_install": False,
        },
        headers=_headers(test_token),
    )

    assert published.status_code == 200
    assert updated.status_code == 200
    assert updated.json()["allow_group_install"] is False


def test_bind_owned_agent_to_personal_scope_by_reference(
    test_client, test_db, test_token, test_user
):
    agent = Kind(
        user_id=test_user.id,
        kind="Team",
        name="owned-api-agent",
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Team",
            "metadata": {
                "name": "owned-api-agent",
                "namespace": "default",
                "displayName": "Owned API Agent",
            },
            "spec": {
                "members": [],
                "collaborationModel": "solo",
                "bind_mode": ["chat"],
                "description": "API test agent",
            },
        },
        is_active=True,
    )
    test_db.add(agent)
    test_db.commit()
    test_db.refresh(agent)
    team_count_before = test_db.query(Kind).filter(Kind.kind == "Team").count()

    bound = test_client.post(
        f"/api/resource-library/agents/{agent.id}/bindings",
        json={"target_namespace": "default"},
        headers=_headers(test_token),
    )
    bindings = test_client.get(
        f"/api/resource-library/agents/{agent.id}/bindings",
        headers=_headers(test_token),
    )
    synced = test_client.put(
        f"/api/resource-library/agents/{agent.id}/bindings",
        json={"group_names": []},
        headers=_headers(test_token),
    )

    assert bound.status_code == 200
    assert bound.json()["installed_kind_id"] == agent.id
    assert bound.json()["installed_reference"]["team_id"] == agent.id
    assert bindings.status_code == 200
    assert bindings.json() == {
        "agent_id": agent.id,
        "personal": True,
        "group_names": [],
    }
    assert synced.status_code == 200
    assert synced.json() == bindings.json()
    assert test_db.query(Kind).filter(Kind.kind == "Team").count() == team_count_before
    assert (
        test_db.query(ResourceMember)
        .filter(
            ResourceMember.resource_type == "Team",
            ResourceMember.resource_id == agent.id,
        )
        .count()
        == 1
    )


def test_list_group_installs_accepts_hierarchical_namespace(
    test_client, test_token, monkeypatch
):
    captured_namespace = None

    def list_group_installs(_db, **kwargs):
        nonlocal captured_namespace
        captured_namespace = kwargs["group_namespace"]
        return {"items": [], "total": 0, "page": 1, "limit": 100}

    monkeypatch.setattr(
        resource_library_service, "list_group_installs", list_group_installs
    )

    response = test_client.get(
        "/api/resource-library/groups/"
        "parent-group%2Fchild-group%2Fproject-team/installs"
        "?resource_type=skill&page=1&limit=100",
        headers=_headers(test_token),
    )

    assert response.status_code == 200
    assert captured_namespace == "parent-group/child-group/project-team"
