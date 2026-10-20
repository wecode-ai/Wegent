"""Exercise the fencing schema migration in both directions."""

import importlib.util
from pathlib import Path

from sqlalchemy import create_engine, inspect, text

from alembic.migration import MigrationContext
from alembic.operations import Operations


def test_fence_migration_upgrade_and_downgrade():
    path = (
        Path(__file__).parents[2]
        / "alembic/versions/20261020_a4b8e2c7d901_add_plugin_write_fences.py"
    )
    spec = importlib.util.spec_from_file_location("fence_migration", path)
    assert spec and spec.loader
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    engine = create_engine("sqlite://")
    with engine.begin() as connection:
        with Operations.context(MigrationContext.configure(connection)):
            migration.upgrade()
            assert inspect(connection).has_table("plugin_write_fences")
            connection.execute(
                text("INSERT INTO plugin_write_fences VALUES (1, 'test-token')")
            )
            assert connection.scalar(text("SELECT token FROM plugin_write_fences"))
            migration.downgrade()
            assert not inspect(connection).has_table("plugin_write_fences")
    engine.dispose()
