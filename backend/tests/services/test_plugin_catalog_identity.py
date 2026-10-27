"""Catalog identity creation preserves ownership and inserts before row locks."""

from sqlalchemy import event

from app.models.plugin_marketplace import Plugin
from app.services.plugin_catalog_identity import ensure_catalog_plugin


def test_catalog_creation_inserts_before_selecting_identity(test_db):
    statements = []

    def record(_connection, _cursor, statement, _parameters, _context, _many):
        if statement.startswith(("INSERT INTO plugins", "SELECT plugins.")):
            statements.append(statement)

    engine = test_db.get_bind()
    event.listen(engine, "before_cursor_execute", record)
    try:
        plugin = ensure_catalog_plugin(
            test_db, {"catalog_namespace": "enterprise", "slug": "lock-order-test"}
        )
        assert plugin.id
    finally:
        event.remove(engine, "before_cursor_execute", record)
    assert statements[0].startswith("INSERT INTO plugins")
    assert statements[1].startswith("SELECT plugins.")


def test_existing_identity_keeps_owner_origin_and_curated_metadata(test_db):
    plugin = Plugin(
        catalog_namespace="enterprise",
        slug="identity-owner-test",
        owner_user_id=123,
        origin_plugin_id=456,
        source_type="submission",
        source_provider="personal",
        listing_type="skill",
        display_name="Curated title",
        keywords_json=["curated"],
    )
    test_db.add(plugin)
    test_db.commit()
    actual = ensure_catalog_plugin(
        test_db,
        {
            "catalog_namespace": "enterprise",
            "slug": "identity-owner-test",
            "owner_user_id": 0,
            "origin_plugin_id": 0,
            "source_type": "native",
            "source_provider": "wework",
            "listing_type": "plugin",
            "display_name": "Replacement",
        },
    )
    assert actual.id == plugin.id
    assert actual.owner_user_id == 123
    assert actual.origin_plugin_id == 456
    assert actual.source_type == "submission"
    assert actual.source_provider == "personal"
    assert actual.listing_type == "skill"
    assert actual.display_name == "Curated title"
    assert actual.keywords_json == ["curated"]


def test_same_slug_in_different_namespaces_remains_distinct(test_db):
    first = ensure_catalog_plugin(
        test_db, {"catalog_namespace": "enterprise", "slug": "catalog-test"}
    )
    second = ensure_catalog_plugin(
        test_db, {"catalog_namespace": "public", "slug": "catalog-test"}
    )
    assert first.id != second.id
