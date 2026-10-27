"""Transaction and collision checks for plugin publication persistence."""

from collections.abc import Iterator
from typing import Any

import pytest
from sqlalchemy import create_engine
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.plugin_marketplace import Plugin, PluginRelease
from app.services.plugin_catalog_storage import (
    create_or_lock_plugin_release,
    lock_catalog_plugin,
)


@pytest.fixture
def catalog_db() -> Iterator[Session]:
    engine = create_engine("sqlite://")
    Plugin.__table__.create(engine)
    PluginRelease.__table__.create(engine)
    with Session(engine) as db:
        yield db
    engine.dispose()


def create_plugin(db: Session, **values: Any) -> Plugin:
    return lock_catalog_plugin(
        db,
        catalog_namespace="enterprise",
        slug="publication-test",
        initial_values={"name": "publication-test", **values},
    )


def release_values(plugin_id: int, **values: Any) -> dict[str, Any]:
    return {
        "plugin_id": plugin_id,
        "version": "1.0.0",
        "sha256": "a" * 64,
        "storage_key": "pending",
        "size_bytes": 1,
        **values,
    }


def test_new_release_rolls_back_without_prior_writes(catalog_db):
    plugin = create_plugin(catalog_db)
    catalog_db.commit()
    _, created = create_or_lock_plugin_release(catalog_db, release_values(plugin.id))
    assert created

    catalog_db.rollback()

    assert catalog_db.query(PluginRelease).count() == 0
    assert catalog_db.query(Plugin).count() == 1


def test_existing_release_keeps_content_and_status(catalog_db):
    plugin = create_plugin(catalog_db)
    original, created = create_or_lock_plugin_release(
        catalog_db, release_values(plugin.id, status="ready")
    )
    assert created
    catalog_db.commit()
    original_id = original.id

    existing, created = create_or_lock_plugin_release(
        catalog_db, release_values(plugin.id, sha256="b" * 64)
    )

    assert not created
    assert existing.id == original_id
    assert existing.sha256 == "a" * 64
    assert existing.status == "ready"
    assert catalog_db.query(PluginRelease).count() == 1


def test_invalid_release_is_not_treated_as_an_existing_version(catalog_db):
    plugin = create_plugin(catalog_db)
    create_or_lock_plugin_release(catalog_db, release_values(plugin.id))
    catalog_db.commit()

    with pytest.raises(IntegrityError):
        create_or_lock_plugin_release(
            catalog_db, release_values(plugin.id, storage_key=None)
        )


def test_existing_catalog_identity_keeps_publisher_metadata(catalog_db):
    original = create_plugin(catalog_db, source_provider="original", owner_user_id=7)
    catalog_db.commit()
    original_id = original.id

    existing = create_plugin(catalog_db, source_provider="replacement", owner_user_id=9)

    assert existing.id == original_id
    assert existing.source_provider == "original"
    assert existing.owner_user_id == 7
