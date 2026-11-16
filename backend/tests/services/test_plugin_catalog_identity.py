"""Catalog identities preserve ownership and lock only after the row exists."""

import pytest
from sqlalchemy import event

from app.models.plugin_marketplace import Plugin
from app.services.plugin_catalog_identity import ensure_catalog_plugin


@pytest.mark.parametrize("already_exists", [False, True])
def test_catalog_identity_inserts_only_when_missing(test_db, already_exists):
    identity = {"catalog_namespace": "enterprise", "slug": "lock-order-test"}
    if already_exists:
        test_db.add(Plugin(**identity))
        test_db.commit()
    statements = []

    def record(_connection, _cursor, statement, _parameters, _context, _many):
        if statement.startswith(("INSERT INTO plugins", "SELECT plugins.")):
            if statement.startswith("SELECT"):
                # SQLite omits FOR UPDATE; compile the SELECT with the generic
                # dialect so the test still checks the requested locking order.
                statement = str(_context.compiled.statement)
            statements.append(statement)

    engine = test_db.get_bind()
    event.listen(engine, "before_cursor_execute", record)
    try:
        plugin = ensure_catalog_plugin(test_db, identity)
        assert plugin.id
    finally:
        event.remove(engine, "before_cursor_execute", record)
    assert statements[0].startswith("SELECT plugins.id")
    operations = [
        (statement.split(maxsplit=1)[0], "FOR UPDATE" in statement)
        for statement in statements
    ]
    assert operations == (
        [("SELECT", False), ("SELECT", True)]
        if already_exists
        else [("SELECT", False), ("INSERT", False), ("SELECT", True)]
    )


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
