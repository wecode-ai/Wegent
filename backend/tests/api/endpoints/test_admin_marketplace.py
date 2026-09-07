# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import io
import json
import zipfile

from app.models.kind import Kind
from app.models.marketplace_resource import MarketplaceResource
from app.models.plugin_marketplace import Plugin, PluginRelease
from app.models.smart_app_marketplace import SmartApp, SmartAppRelease
from app.services.marketplace_artifact_storage import marketplace_artifact_storage


def _headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _official_smart_app_package(
    version: str = "1.0.0", *, include_marketplace_metadata: bool = True
) -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        archive.writestr(
            "plugin-manifest.json",
            json.dumps(
                {
                    "name": "admin-official-app",
                    "displayName": "Admin Official App",
                    "version": version,
                    "type": "deepseek-harness-plugin-bundle",
                    "description": "Imported by an administrator",
                    "entry": {"installPackage": "bundle", "profile": "official"},
                    "requirements": {"dsh": "0.1.0", "node": ">=22"},
                }
            ),
        )
        archive.writestr("bundle/package.json", "{}")
        archive.writestr("bundle/cordis.patch.yml", "plugins: []")
        if include_marketplace_metadata:
            archive.writestr("icon.png", b"png-image")
            archive.writestr(
                "smart-app-marketplace.json",
                json.dumps(
                    {
                        "summary": "Official import",
                        "descriptionMd": "# Official import",
                        "tags": ["data_analysis"],
                        "icon": "icon.png",
                        "releaseNotes": "Initial version",
                    }
                ),
            )
    return output.getvalue()


def _mock_smart_app_storage(monkeypatch) -> dict[str, bytes]:
    values: dict[str, bytes] = {}
    monkeypatch.setattr(
        marketplace_artifact_storage,
        "put",
        lambda key, value, *, content_type: values.__setitem__(key, value),
    )
    monkeypatch.setattr(
        marketplace_artifact_storage,
        "put_immutable",
        lambda key, value, *, content_type: values.setdefault(key, value) == value,
    )
    monkeypatch.setattr(marketplace_artifact_storage, "get", lambda key: values[key])
    monkeypatch.setattr(
        marketplace_artifact_storage, "delete", lambda key: values.pop(key, None)
    )
    monkeypatch.setattr(
        marketplace_artifact_storage,
        "presign_download",
        lambda key: (f"https://assets.example/{key}", None),
    )
    return values


def _marketplace_plugin(
    test_db,
    *,
    catalog_namespace: str,
    slug: str,
    status: str = "published",
    featured_rank: int = 0,
    release_status: str = "ready",
    scan_status: str = "passed",
) -> Plugin:
    plugin = Plugin(
        catalog_namespace=catalog_namespace,
        slug=slug,
        name=slug,
        display_name=slug.replace("-", " ").title(),
        summary=f"{slug} marketplace summary",
        description_md=f"# {slug}",
        visibility="public" if catalog_namespace == "wework-official" else "workspace",
        status=status,
        featured_rank=featured_rank,
    )
    test_db.add(plugin)
    test_db.flush()
    release = PluginRelease(
        plugin_id=plugin.id,
        version="1.2.3",
        manifest_json={"author": {"name": "Wegent"}},
        status=release_status,
        scan_status=scan_status,
    )
    test_db.add(release)
    test_db.flush()
    plugin.latest_release_id = release.id
    test_db.commit()
    test_db.refresh(plugin)
    return plugin


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


def test_system_recommendation_score_changes_keep_listing_public(
    test_client,
    test_db,
    test_admin_token,
    test_token,
):
    agent = _resource(
        test_db,
        user_id=0,
        kind="Team",
        name="system-score-change-agent",
    )

    raised = test_client.put(
        f"/api/admin/marketplace-resources/{agent.id}",
        json={"recommendation_score": 90},
        headers=_headers(test_admin_token),
    )
    reset = test_client.put(
        f"/api/admin/marketplace-resources/{agent.id}",
        json={"recommendation_score": 0},
        headers=_headers(test_admin_token),
    )
    detail = test_client.get(
        f"/api/resource-library/listings/{agent.id}",
        headers=_headers(test_token),
    )

    assert raised.status_code == 200
    assert reset.status_code == 200
    assert detail.status_code == 200
    assert detail.json()["id"] == agent.id


def test_admin_imports_official_smart_app_directly(
    test_client,
    test_db,
    test_admin_token,
    test_token,
    monkeypatch,
):
    _mock_smart_app_storage(monkeypatch)
    package = _official_smart_app_package()

    forbidden = test_client.post(
        "/api/admin/marketplace-smart-apps/import",
        files={"package": ("official.zip", package, "application/zip")},
        headers=_headers(test_token),
    )
    imported = test_client.post(
        "/api/admin/marketplace-smart-apps/import",
        files={"package": ("official.zip", package, "application/zip")},
        headers=_headers(test_admin_token),
    )

    assert forbidden.status_code == 403
    assert imported.status_code == 200
    assert imported.json()["display_name"] == "Admin Official App"
    assert imported.json()["is_system"] is True
    assert imported.json()["is_listed"] is True
    app = test_db.get(SmartApp, imported.json()["id"])
    assert app.owner_user_id == 0
    assert app.source_type == "official"
    assert app.visibility == "public"
    assert app.status == "published"

    app.featured_rank = 90
    test_db.commit()
    updated = test_client.post(
        "/api/admin/marketplace-smart-apps/import",
        files={
            "package": (
                "official.zip",
                _official_smart_app_package("1.1.0"),
                "application/zip",
            )
        },
        headers=_headers(test_admin_token),
    )

    assert updated.status_code == 200
    assert updated.json()["featured_rank"] == 90


def test_admin_imports_plain_wework_package_then_completes_marketplace_metadata(
    test_client,
    test_db,
    test_admin_token,
    monkeypatch,
):
    _mock_smart_app_storage(monkeypatch)
    package = _official_smart_app_package(include_marketplace_metadata=False)

    imported = test_client.post(
        "/api/admin/marketplace-smart-apps/import",
        files={"package": ("plain.zip", package, "application/zip")},
        headers=_headers(test_admin_token),
    )

    assert imported.status_code == 200
    assert imported.json()["summary"] == "Imported by an administrator"
    assert imported.json()["icon_url"] == ""
    assert imported.json()["tags"] == []
    assert imported.json()["needs_metadata"] is True

    completed = test_client.put(
        f"/api/admin/marketplace-smart-apps/{imported.json()['id']}/metadata",
        data={
            "summary": "Spreadsheet dashboard",
            "description_md": "# Spreadsheet dashboard",
            "tags": json.dumps(["data_analysis"]),
        },
        files={"icon": ("icon.png", b"png-image", "image/png")},
        headers=_headers(test_admin_token),
    )

    assert completed.status_code == 200
    assert completed.json()["summary"] == "Spreadsheet dashboard"
    assert completed.json()["tags"] == ["data_analysis"]
    assert completed.json()["icon_url"]
    assert completed.json()["needs_metadata"] is False

    next_version = test_client.post(
        "/api/admin/marketplace-smart-apps/import",
        files={
            "package": (
                "plain-1.1.0.zip",
                _official_smart_app_package(
                    "1.1.0", include_marketplace_metadata=False
                ),
                "application/zip",
            )
        },
        headers=_headers(test_admin_token),
    )

    assert next_version.status_code == 200
    app = test_db.get(SmartApp, imported.json()["id"])
    release = test_db.get(SmartAppRelease, app.latest_release_id)
    assert release.version == "1.1.0"
    assert next_version.json()["summary"] == "Spreadsheet dashboard"
    assert next_version.json()["description_md"] == "# Spreadsheet dashboard"
    assert next_version.json()["tags"] == ["data_analysis"]
    assert next_version.json()["icon_url"] == completed.json()["icon_url"]
    assert next_version.json()["needs_metadata"] is False


def test_admin_permanently_deletes_only_official_marketplace_smart_apps(
    test_client,
    test_db,
    test_admin_token,
    test_token,
    test_user,
    monkeypatch,
):
    stored_artifacts = _mock_smart_app_storage(monkeypatch)
    imported = test_client.post(
        "/api/admin/marketplace-smart-apps/import",
        files={
            "package": (
                "official.zip",
                _official_smart_app_package(),
                "application/zip",
            )
        },
        headers=_headers(test_admin_token),
    )
    app_id = imported.json()["id"]
    release_id = test_db.get(SmartApp, app_id).latest_release_id
    user_app = SmartApp(
        owner_user_id=test_user.id,
        name="user-marketplace-app",
        display_name="User Marketplace App",
        summary="User-owned app",
        source_type="user",
        visibility="public",
        status="published",
    )
    test_db.add(user_app)
    test_db.commit()

    forbidden = test_client.delete(
        f"/api/admin/marketplace-smart-apps/{app_id}",
        headers=_headers(test_token),
    )
    user_owned = test_client.delete(
        f"/api/admin/marketplace-smart-apps/{user_app.id}",
        headers=_headers(test_admin_token),
    )
    deleted = test_client.delete(
        f"/api/admin/marketplace-smart-apps/{app_id}",
        headers=_headers(test_admin_token),
    )

    assert forbidden.status_code == 403
    assert user_owned.status_code == 404
    assert deleted.status_code == 204
    assert test_db.get(SmartApp, app_id) is None
    assert test_db.get(SmartAppRelease, release_id) is None
    assert test_db.get(SmartApp, user_app.id) is not None
    assert stored_artifacts == {}


def test_admin_prioritizes_only_public_marketplace_smart_apps(
    test_client,
    test_db,
    test_admin_token,
    test_token,
    test_user,
    monkeypatch,
):
    monkeypatch.setattr(
        marketplace_artifact_storage,
        "presign_download",
        lambda key: (f"https://assets.example/{key}", None),
    )
    official = SmartApp(
        owner_user_id=0,
        name="official-smart-app",
        display_name="Official Smart App",
        summary="Official",
        description_md="Classifies spreadsheet rows for demonstrations.",
        icon_storage_key="smart-apps/assets/official/icon.png",
        source_type="official",
        visibility="public",
        status="published",
        featured_rank=0,
    )
    public_user_app = SmartApp(
        owner_user_id=test_user.id,
        name="public-user-smart-app",
        display_name="Public User Smart App",
        summary="Public user app",
        source_type="user",
        visibility="public",
        status="published",
        featured_rank=0,
        is_listed=False,
    )
    restricted = SmartApp(
        owner_user_id=test_user.id,
        name="restricted-smart-app",
        display_name="Restricted Smart App",
        source_type="user",
        visibility="restricted",
        status="published",
        featured_rank=100,
    )
    test_db.add_all([official, public_user_app, restricted])
    test_db.commit()

    listed = test_client.get(
        "/api/admin/marketplace-smart-apps",
        headers=_headers(test_admin_token),
    )
    searched = test_client.get(
        "/api/admin/marketplace-smart-apps?search=spreadsheet",
        headers=_headers(test_admin_token),
    )
    listed_only = test_client.get(
        "/api/admin/marketplace-smart-apps?listing_status=listed",
        headers=_headers(test_admin_token),
    )
    user_only = test_client.get(
        "/api/admin/marketplace-smart-apps?source=user",
        headers=_headers(test_admin_token),
    )
    forbidden = test_client.put(
        f"/api/admin/marketplace-smart-apps/{official.id}",
        json={"featured_rank": 90},
        headers=_headers(test_token),
    )
    updated = test_client.put(
        f"/api/admin/marketplace-smart-apps/{official.id}",
        json={"featured_rank": 90, "is_listed": False},
        headers=_headers(test_admin_token),
    )
    relisted = test_client.get(
        "/api/admin/marketplace-smart-apps",
        headers=_headers(test_admin_token),
    )
    second_page = test_client.get(
        "/api/admin/marketplace-smart-apps?page=2&limit=1",
        headers=_headers(test_admin_token),
    )

    assert listed.status_code == 200
    assert [item["id"] for item in listed.json()["items"]] == [
        official.id,
        public_user_app.id,
    ]
    official_item = next(
        item for item in listed.json()["items"] if item["id"] == official.id
    )
    assert official_item["description_md"] == (
        "Classifies spreadsheet rows for demonstrations."
    )
    assert official_item["icon_url"] == (
        "https://assets.example/smart-apps/assets/official/icon.png"
    )
    assert searched.status_code == 200
    assert [item["id"] for item in searched.json()["items"]] == [official.id]
    assert listed_only.status_code == 200
    assert [item["id"] for item in listed_only.json()["items"]] == [official.id]
    assert user_only.status_code == 200
    assert [item["id"] for item in user_only.json()["items"]] == [public_user_app.id]
    assert forbidden.status_code == 403
    assert updated.status_code == 200
    assert updated.json()["featured_rank"] == 90
    assert updated.json()["is_listed"] is False
    assert [item["id"] for item in relisted.json()["items"]] == [
        official.id,
        public_user_app.id,
    ]
    assert second_page.status_code == 200
    assert second_page.json()["total"] == 2
    assert [item["id"] for item in second_page.json()["items"]] == [public_user_app.id]
    assert second_page.json()["items"][0]["is_listed"] is False
    assert restricted.id not in {item["id"] for item in relisted.json()["items"]}


def test_admin_lists_only_managed_plugins_with_filters_and_score_order(
    test_client,
    test_db,
    test_admin_token,
    test_token,
):
    official = _marketplace_plugin(
        test_db,
        catalog_namespace="wework-official",
        slug="official-mail",
        featured_rank=80,
    )
    enterprise = _marketplace_plugin(
        test_db,
        catalog_namespace="enterprise",
        slug="enterprise-docs",
        featured_rank=95,
    )
    unlisted = _marketplace_plugin(
        test_db,
        catalog_namespace="wework-official",
        slug="official-unlisted",
        status="unpublished",
        featured_rank=70,
    )
    personal = _marketplace_plugin(
        test_db,
        catalog_namespace="personal/42",
        slug="personal-hidden",
        featured_rank=100,
    )
    pending = _marketplace_plugin(
        test_db,
        catalog_namespace="enterprise",
        slug="enterprise-pending",
        status="pending_review",
        featured_rank=100,
    )

    listed = test_client.get(
        "/api/admin/marketplace-plugins",
        headers=_headers(test_admin_token),
    )
    official_only = test_client.get(
        "/api/admin/marketplace-plugins?source=wework-official",
        headers=_headers(test_admin_token),
    )
    published_only = test_client.get(
        "/api/admin/marketplace-plugins?listing_status=listed",
        headers=_headers(test_admin_token),
    )
    searched = test_client.get(
        "/api/admin/marketplace-plugins?search=docs",
        headers=_headers(test_admin_token),
    )
    page_two = test_client.get(
        "/api/admin/marketplace-plugins?page=2&limit=1",
        headers=_headers(test_admin_token),
    )
    ascending = test_client.get(
        "/api/admin/marketplace-plugins?score_order=asc",
        headers=_headers(test_admin_token),
    )
    forbidden = test_client.get(
        "/api/admin/marketplace-plugins",
        headers=_headers(test_token),
    )

    assert listed.status_code == 200
    assert listed.json()["total"] == 3
    assert [item["id"] for item in listed.json()["items"]] == [
        official.id,
        unlisted.id,
        enterprise.id,
    ]
    assert listed.json()["items"][0]["version"] == "1.2.3"
    assert listed.json()["items"][0]["author"] == "Wegent"
    assert listed.json()["items"][0]["created_at"]
    assert [item["id"] for item in official_only.json()["items"]] == [
        official.id,
        unlisted.id,
    ]
    assert [item["id"] for item in published_only.json()["items"]] == [
        official.id,
        enterprise.id,
    ]
    assert [item["id"] for item in searched.json()["items"]] == [enterprise.id]
    assert page_two.json()["total"] == 3
    assert [item["id"] for item in page_two.json()["items"]] == [unlisted.id]
    assert [item["id"] for item in ascending.json()["items"]] == [
        unlisted.id,
        official.id,
        enterprise.id,
    ]
    assert forbidden.status_code == 403
    assert personal.id not in {item["id"] for item in listed.json()["items"]}
    assert pending.id not in {item["id"] for item in listed.json()["items"]}


def test_admin_updates_plugin_description_score_and_listing_state(
    test_client,
    test_db,
    test_admin_token,
):
    plugin = _marketplace_plugin(
        test_db,
        catalog_namespace="wework-official",
        slug="editable-plugin",
        featured_rank=60,
    )
    incomplete = _marketplace_plugin(
        test_db,
        catalog_namespace="enterprise",
        slug="incomplete-plugin",
        status="unpublished",
        release_status="processing",
        scan_status="pending",
    )
    personal = _marketplace_plugin(
        test_db,
        catalog_namespace="personal/42",
        slug="personal-plugin",
    )

    updated = test_client.put(
        f"/api/admin/marketplace-plugins/{plugin.id}",
        json={
            "description": "  Updated marketplace description  ",
            "featured_rank": 98,
            "is_listed": False,
        },
        headers=_headers(test_admin_token),
    )
    relisted = test_client.put(
        f"/api/admin/marketplace-plugins/{plugin.id}",
        json={"is_listed": True},
        headers=_headers(test_admin_token),
    )
    cleared = test_client.put(
        f"/api/admin/marketplace-plugins/{plugin.id}",
        json={"description": ""},
        headers=_headers(test_admin_token),
    )
    rejected = test_client.put(
        f"/api/admin/marketplace-plugins/{incomplete.id}",
        json={"is_listed": True},
        headers=_headers(test_admin_token),
    )
    unmanaged = test_client.put(
        f"/api/admin/marketplace-plugins/{personal.id}",
        json={"featured_rank": 10},
        headers=_headers(test_admin_token),
    )

    assert updated.status_code == 200
    assert updated.json()["description"] == "Updated marketplace description"
    assert updated.json()["featured_rank"] == 98
    assert updated.json()["is_listed"] is False
    assert test_db.get(Plugin, plugin.id).status == "published"
    assert relisted.status_code == 200
    assert relisted.json()["is_listed"] is True
    assert cleared.status_code == 200
    assert cleared.json()["description"] == ""
    assert test_db.get(Plugin, plugin.id).description_md == ""
    assert rejected.status_code == 409
    assert unmanaged.status_code == 404
