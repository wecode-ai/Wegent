"""Regression coverage for marketplace metadata across plugin releases."""

from unittest.mock import Mock

import pytest

from app.api.endpoints.admin.marketplace import update_marketplace_plugin
from app.models.plugin_marketplace import Plugin, PluginSubmission
from app.schemas.admin_marketplace import AdminMarketplacePluginUpdate
from app.services.plugin_marketplace_service import PluginMarketplaceService
from app.services.plugin_publication_artifact import expected_release_idempotency_key
from app.services.plugin_publication_service import PluginPublicationService
from tests.services.test_plugin_publication_service import (
    FakeGitLab,
    FakeStorage,
    _plugin_zip,
    _release_metadata,
)


@pytest.fixture
def marketplace(monkeypatch):
    monkeypatch.setattr(
        "app.services.plugin_marketplace_service.plugin_package_storage", FakeStorage()
    )
    return PluginMarketplaceService(release_notifier=Mock())


def _package(version: str) -> bytes:
    return _plugin_zip(
        version=version,
        manifest_extra={
            "description": f"Description {version}",
            "interface": {
                "displayName": f"Plugin {version}",
                "shortDescription": f"Summary {version}",
                "category": "development" if version == "1.0.0" else "productivity",
            },
        },
    )


@pytest.mark.parametrize("version", ["1.0.0", "2.0.0"])
@pytest.mark.parametrize("rank", [80, -10])
def test_enterprise_pipeline_preserves_rank_and_catalog_metadata(
    test_db, marketplace, version, rank
):
    initial_package = _package("1.0.0")
    initial = marketplace.publish_catalog_release(
        test_db,
        catalog_namespace="enterprise",
        slug="publication-test",
        package=initial_package,
        featured_rank=rank,
    )
    plugin = test_db.get(Plugin, initial.release.plugin_id)
    plugin.keywords_json = ["curated"]
    plugin.allow_copy = True
    test_db.commit()
    published_at = plugin.published_at
    created_at = plugin.created_at
    service = PluginPublicationService(
        gitlab=FakeGitLab(), marketplace=marketplace, storage=FakeStorage()
    )
    package = initial_package if version == "1.0.0" else _package(version)
    metadata = _release_metadata(package, commit_sha="b" * 40, version=version)

    result = service.publish_enterprise_release(
        test_db,
        package=package,
        metadata=metadata,
        idempotency_key=expected_release_idempotency_key(
            metadata.model_dump(mode="json")
        ),
        release_key_id=9,
    )

    test_db.refresh(plugin)
    assert result.created is (version == "2.0.0")
    assert plugin.featured_rank == rank
    assert plugin.keywords_json == ["curated"]
    assert plugin.allow_copy is True
    assert plugin.published_at == published_at
    assert plugin.created_at == created_at
    assert plugin.visibility == "workspace"
    assert plugin.owner_user_id == 0
    assert plugin.origin_plugin_id == 0
    assert plugin.latest_release_id == result.releaseId


@pytest.mark.parametrize("visibility", ["workspace", "public"])
@pytest.mark.parametrize("version", ["1.0.0", "2.0.0"])
@pytest.mark.parametrize("rank", [None, 0, 25, -5])
def test_official_publish_only_changes_explicit_rank(
    test_db, marketplace, visibility, version, rank
):
    initial_package = _package("1.0.0")
    first = marketplace.publish_official_release(
        test_db,
        slug="publication-test",
        package=initial_package,
        visibility=visibility,
        featured_rank=80,
    )

    marketplace.publish_official_release(
        test_db,
        slug="publication-test",
        package=initial_package if version == "1.0.0" else _package(version),
        visibility=visibility,
        featured_rank=rank,
    )

    test_db.expire_all()
    plugin = test_db.get(Plugin, first.release.plugin_id)
    assert plugin.featured_rank == (80 if rank is None else rank)


@pytest.mark.parametrize("description", ["Curated marketplace description", ""])
@pytest.mark.parametrize("is_listed", [True, False])
async def test_publish_preserves_admin_copy_and_listing_state(
    test_db, test_admin_user, marketplace, description, is_listed
):
    first = marketplace.publish_official_release(
        test_db, slug="publication-test", package=_package("1.0.0")
    )
    plugin = test_db.get(Plugin, first.release.plugin_id)
    await update_marketplace_plugin(
        update=AdminMarketplacePluginUpdate(
            description=description, is_listed=is_listed, featured_rank=60
        ),
        plugin_id=plugin.id,
        db=test_db,
        current_user=test_admin_user,
    )

    for version in ("2.0.0", "3.0.0"):
        result = marketplace.publish_official_release(
            test_db, slug="publication-test", package=_package(version)
        )

        test_db.refresh(plugin)
        assert plugin.summary == description
        assert plugin.description_md == (
            f"Description {version}" if description else ""
        )
        assert plugin.status == ("published" if is_listed else "unpublished")
        assert plugin.featured_rank == 60
        assert plugin.latest_release_id == result.release.id
        assert plugin.display_name == f"Plugin {version}"
        assert result.release.status == "ready"
        items = marketplace.list_plugins(test_db, user_id=test_admin_user.id).items
        assert bool(items) is is_listed


def test_new_release_updates_unedited_package_metadata(test_db, marketplace):
    first = marketplace.publish_official_release(
        test_db, slug="publication-test", package=_package("1.0.0")
    )
    plugin = test_db.get(Plugin, first.release.plugin_id)
    assert plugin.featured_rank == 0

    second = marketplace.publish_official_release(
        test_db, slug="publication-test", package=_package("2.0.0")
    )

    test_db.refresh(plugin)
    assert plugin.summary == "Description 2.0.0"
    assert plugin.description_md == "Description 2.0.0"
    assert plugin.display_name == "Plugin 2.0.0"
    assert plugin.category == "productivity"
    assert plugin.interface_json == second.release.interface_json
    assert plugin.latest_release_id == second.release.id


def test_older_personal_release_does_not_overwrite_latest_listing(
    test_db, test_user, marketplace
):
    plugin = Plugin(
        catalog_namespace=f"personal/{test_user.id}",
        slug="publication-test",
        name="publication-test",
        owner_user_id=test_user.id,
        visibility="personal",
    )
    test_db.add(plugin)
    test_db.commit()
    latest = marketplace.publish_personal_release(
        test_db,
        plugin_id=plugin.id,
        owner_user_id=test_user.id,
        package=_package("2.0.0"),
    )

    older = marketplace.publish_personal_release(
        test_db,
        plugin_id=plugin.id,
        owner_user_id=test_user.id,
        package=_package("1.0.0"),
    )

    test_db.refresh(plugin)
    assert older.created is True
    assert older.release.status == "ready"
    assert plugin.latest_release_id == latest.release.id
    assert plugin.display_name == "Plugin 2.0.0"
    assert plugin.summary == "Description 2.0.0"
    assert plugin.description_md == "Description 2.0.0"
    assert plugin.category == "productivity"
    assert plugin.interface_json == latest.release.interface_json


@pytest.mark.parametrize("approved", [True, False])
async def test_mirror_review_preserves_admin_delisting(
    test_db, test_admin_user, marketplace, monkeypatch, approved
):
    monkeypatch.setattr(
        "app.services.plugin_marketplace_service.validate_upstream_url",
        lambda url: None,
    )
    upstream = marketplace.configure_controlled_upstream(
        test_db,
        slug="publication-test",
        display_name="Publication test",
        marketplace_name="example/plugins",
        remote_plugin_id="publication-test",
        upstream_url="https://github.com/example/plugins/archive/main.zip",
        license_info="MIT",
        visibility="public",
    )
    monkeypatch.setattr(
        "app.services.plugin_marketplace_service.fetch_upstream_package",
        lambda url: _package("1.0.0"),
    )
    marketplace.sync_upstream(test_db, upstream_id=upstream.id)
    plugin = test_db.get(Plugin, upstream.pluginId)
    previous_release_id = plugin.latest_release_id
    await update_marketplace_plugin(
        update=AdminMarketplacePluginUpdate(is_listed=False),
        plugin_id=plugin.id,
        db=test_db,
        current_user=test_admin_user,
    )
    marketplace.update_upstream_policy(
        test_db, upstream_id=upstream.id, sync_policy="review_required"
    )
    monkeypatch.setattr(
        "app.services.plugin_marketplace_service.fetch_upstream_package",
        lambda url: _package("2.0.0"),
    )

    marketplace.sync_upstream(test_db, upstream_id=upstream.id)

    test_db.refresh(plugin)
    assert plugin.status == "unpublished"
    submission = test_db.query(PluginSubmission).filter_by(plugin_id=plugin.id).one()
    marketplace.review_submission(
        test_db,
        reviewer_user_id=test_admin_user.id,
        submission_id=submission.id,
        approved=approved,
        note="Review package without relisting",
    )
    test_db.refresh(plugin)
    assert plugin.status == "unpublished"
    assert plugin.latest_release_id == (
        submission.release_id if approved else previous_release_id
    )
