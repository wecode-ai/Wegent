from app.models.resource_library import (
    RESOURCE_LIBRARY_STATUS_PUBLISHED,
    RESOURCE_TYPE_AGENT,
    ResourceLibraryInstall,
    ResourceLibraryListing,
    ResourceLibraryVersion,
)


def test_resource_library_model_indexes_match_migration_contract():
    expected_indexes = {
        ResourceLibraryListing.__tablename__: {
            "ix_resource_library_listings_discovery",
            "ix_resource_library_listings_publisher_user_id",
        },
        ResourceLibraryVersion.__tablename__: {
            "ix_resource_library_versions_current",
        },
        ResourceLibraryInstall.__tablename__: {
            "ix_resource_library_installs_user_type_status",
            "ix_resource_library_installs_version_id",
        },
    }

    model_indexes = {
        model.__tablename__: {index.name for index in model.__table__.indexes}
        for model in (
            ResourceLibraryListing,
            ResourceLibraryVersion,
            ResourceLibraryInstall,
        )
    }

    assert model_indexes == expected_indexes


def test_resource_library_listing_version_and_install_persist(test_db, test_user):
    listing = ResourceLibraryListing(
        resource_type=RESOURCE_TYPE_AGENT,
        name="research-agent",
        display_name="Research Agent",
        description="Collects and summarizes source material",
        tags=["research", "summary"],
        publisher_user_id=test_user.id,
        status=RESOURCE_LIBRARY_STATUS_PUBLISHED,
    )
    test_db.add(listing)
    test_db.commit()
    test_db.refresh(listing)

    version = ResourceLibraryVersion(
        listing_id=listing.id,
        version="1.0.0",
        manifest={"resource_type": "agent", "team": {"name": "research-agent"}},
        is_current=True,
    )
    test_db.add(version)
    test_db.commit()
    test_db.refresh(version)

    listing.current_version_id = version.id
    install = ResourceLibraryInstall(
        listing_id=listing.id,
        version_id=version.id,
        user_id=test_user.id,
        resource_type=RESOURCE_TYPE_AGENT,
        install_status="installed",
        installed_reference={
            "team_id": 101,
            "namespace": "default",
            "name": "research-agent",
        },
    )
    test_db.add(install)
    test_db.commit()
    test_db.refresh(install)

    assert listing.id > 0
    assert version.id > 0
    assert install.installed_reference["team_id"] == 101
