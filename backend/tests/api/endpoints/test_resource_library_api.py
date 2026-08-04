# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from sqlalchemy.orm.attributes import flag_modified

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


def test_marketplace_tags_endpoint_returns_default_catalog(test_client, test_token):
    response = test_client.get(
        "/api/resource-library/tags",
        headers=_headers(test_token),
    )

    assert response.status_code == 200
    assert response.json()["version"] == 0
    assert response.json()["items"][0]["id"] == "product_design"


def test_marketplace_filter_ignores_skill_package_tags(
    test_client, test_db, test_token
):
    skill = _system_skill(test_db, name="package-tag-only-skill")
    skill.json["spec"]["tags"] = ["technical_development"]
    flag_modified(skill, "json")
    test_db.commit()

    response = test_client.get(
        "/api/resource-library/listings"
        "?resource_type=skill&tags=technical_development",
        headers=_headers(test_token),
    )

    assert response.status_code == 200
    assert response.json()["items"] == []


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
            "tags": ["technical_development"],
            "version": "1.0.0",
        },
        headers=_headers(test_token),
    )
    updated = test_client.put(
        f"/api/resource-library/listings/{skill.id}/publication",
        json={
            "allow_group_install": False,
            "tags": ["data_analysis"],
        },
        headers=_headers(test_token),
    )

    assert published.status_code == 200
    assert updated.status_code == 200
    assert updated.json()["allow_group_install"] is False
    assert updated.json()["tags"] == ["data_analysis"]


def test_admin_can_edit_system_resource_tags(
    test_client, test_db, test_admin_token, test_token
):
    skill = _system_skill(test_db, name="system-tag-edit-skill")

    updated = test_client.put(
        f"/api/resource-library/listings/{skill.id}/publication",
        json={"tags": ["technical_development"]},
        headers=_headers(test_admin_token),
    )
    forbidden = test_client.put(
        f"/api/resource-library/listings/{skill.id}/publication",
        json={"tags": ["data_analysis"]},
        headers=_headers(test_token),
    )
    filtered = test_client.get(
        "/api/resource-library/listings"
        "?resource_type=skill&tags=technical_development"
        "&keyword=system-tag-edit",
        headers=_headers(test_token),
    )

    assert updated.status_code == 200
    assert updated.json()["tags"] == ["technical_development"]
    assert forbidden.status_code == 403
    assert [item["id"] for item in filtered.json()["items"]] == [skill.id]
    test_db.refresh(skill)
    assert skill.json["spec"]["capability"]["tags"] == ["technical_development"]


def test_publish_requires_configured_marketplace_tag(
    test_client, test_db, test_token, test_user
):
    skill = _system_skill(test_db, name="invalid-tag-skill")
    skill.user_id = test_user.id
    test_db.commit()

    missing = test_client.post(
        "/api/resource-library/listings",
        json={
            "resource_type": "skill",
            "source_id": skill.id,
            "name": skill.name,
            "display_name": "Invalid Tag Skill",
            "tags": [],
            "version": "1.0.0",
        },
        headers=_headers(test_token),
    )
    unknown = test_client.post(
        "/api/resource-library/listings",
        json={
            "resource_type": "skill",
            "source_id": skill.id,
            "name": skill.name,
            "display_name": "Invalid Tag Skill",
            "tags": ["not_configured"],
            "version": "1.0.0",
        },
        headers=_headers(test_token),
    )
    too_many = test_client.post(
        "/api/resource-library/listings",
        json={
            "resource_type": "skill",
            "source_id": skill.id,
            "name": skill.name,
            "display_name": "Invalid Tag Skill",
            "tags": [
                "product_design",
                "technical_development",
                "data_analysis",
                "daily_work",
            ],
            "version": "1.0.0",
        },
        headers=_headers(test_token),
    )

    assert missing.status_code == 400
    assert unknown.status_code == 400
    assert too_many.status_code == 400


def test_admin_can_update_marketplace_tag_config(
    test_client, test_admin_token, test_token
):
    admin_headers = _headers(test_admin_token)
    current = test_client.get(
        "/api/admin/system-config/marketplace-tags",
        headers=admin_headers,
    )
    items = current.json()["items"]
    items[0]["name_zh"] = "产品设计"

    updated = test_client.put(
        "/api/admin/system-config/marketplace-tags",
        json={"expected_version": current.json()["version"], "items": items},
        headers=admin_headers,
    )
    forbidden = test_client.put(
        "/api/admin/system-config/marketplace-tags",
        json={"expected_version": current.json()["version"], "items": items},
        headers=_headers(test_token),
    )

    assert current.status_code == 200
    assert updated.status_code == 200
    assert updated.json()["version"] == 1
    assert updated.json()["items"][0]["name_zh"] == "产品设计"
    assert forbidden.status_code == 403


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


def test_list_group_installs_batch_parses_group_names(
    test_client, test_token, monkeypatch
):
    captured_namespaces = None

    def list_group_installs_batch(_db, **kwargs):
        nonlocal captured_namespaces
        captured_namespaces = kwargs["group_namespaces"]
        return {"items": [], "total": 0, "page": 1, "limit": 100}

    monkeypatch.setattr(
        resource_library_service,
        "list_group_installs_batch",
        list_group_installs_batch,
    )

    response = test_client.get(
        "/api/resource-library/groups/installs"
        "?group_names=engineering,platform%2Fteam,engineering"
        "&resource_type=skill&page=1&limit=100",
        headers=_headers(test_token),
    )

    assert response.status_code == 200
    assert captured_namespaces == ["engineering", "platform/team"]


def test_list_group_installs_batch_rejects_too_many_groups(test_client, test_token):
    group_names = ",".join(f"group-{index}" for index in range(101))

    response = test_client.get(
        f"/api/resource-library/groups/installs?group_names={group_names}",
        headers=_headers(test_token),
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "At most 100 groups can be queried at once"
