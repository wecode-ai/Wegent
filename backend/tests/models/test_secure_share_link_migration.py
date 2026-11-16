"""Verify the secure share-link token migration contract."""

import importlib.util
from io import StringIO
from pathlib import Path
from types import ModuleType

from alembic.migration import MigrationContext
from alembic.operations import Operations


def _load_migration(operations: Operations) -> ModuleType:
    filename = "20261106_b1c2d3e4f5a6_secure_share_link_tokens.py"
    path = Path(__file__).parents[2] / "alembic" / "versions" / filename
    spec = importlib.util.spec_from_file_location(filename.removesuffix(".py"), path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.op = operations
    return module


def test_mysql_migration_backfills_decoded_legacy_hashes() -> None:
    output = StringIO()
    operations = Operations(
        MigrationContext.configure(
            dialect_name="mysql", opts={"as_sql": True, "output_buffer": output}
        )
    )
    migration = _load_migration(operations)

    migration.upgrade()
    upgrade_sql = output.getvalue()
    assert "ADD COLUMN token_version INTEGER NOT NULL DEFAULT '1'" in upgrade_sql
    assert "SET DEFAULT '2'" not in upgrade_sql
    assert "ALTER TABLE share_links ADD COLUMN token_hash VARCHAR(64)" in upgrade_sql
    assert (
        "UPDATE share_links SET token_hash = SHA2(REPLACE(REPLACE(share_token, '%%2B', '+'), '%%3D', '='), 256) WHERE token_hash IS NULL"
        in upgrade_sql
    )
    assert "MODIFY token_hash VARCHAR(64) NOT NULL" not in upgrade_sql
    assert "ALTER TABLE share_links ADD CONSTRAINT uniq_share_links_token_hash" in (
        upgrade_sql
    )
    assert upgrade_sql.count("uniq_share_links_token_hash") == 1
    assert "idx_share_links_token_hash_active" not in upgrade_sql

    output.seek(0)
    output.truncate()
    migration.downgrade()
    downgrade_sql = output.getvalue()
    assert "ALTER TABLE share_links DROP INDEX uniq_share_links_token_hash" in (
        downgrade_sql
    )
    assert "ALTER TABLE share_links DROP COLUMN token_hash" in downgrade_sql
    assert "ALTER TABLE share_links DROP COLUMN token_version" in downgrade_sql
    assert "idx_share_links_token_hash_active" not in downgrade_sql
