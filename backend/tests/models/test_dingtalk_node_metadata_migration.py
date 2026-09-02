# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Run the metadata migration through Alembic against a legacy cache."""

from pathlib import Path

import sqlalchemy as sa

from alembic import command
from alembic.config import Config
from app.core.config import settings

TARGET_REVISION = "d6e7f8a9b0c1"


def test_upgrade_head_and_rollback_preserve_cached_nodes(tmp_path, monkeypatch) -> None:
    url = f"sqlite:///{tmp_path / 'migration.db'}"
    engine = sa.create_engine(url)
    with engine.begin() as connection:
        connection.execute(
            sa.text(
                "CREATE TABLE dingtalk_synced_nodes (id INTEGER PRIMARY KEY, node_type VARCHAR(32) NOT NULL)"
            )
        )
        connection.execute(
            sa.text("INSERT INTO dingtalk_synced_nodes VALUES (1, 'doc'), (2, 'file')")
        )
        connection.execute(
            sa.text(
                "CREATE TABLE alembic_version (version_num VARCHAR(32) PRIMARY KEY)"
            )
        )
        connection.execute(
            sa.text("INSERT INTO alembic_version VALUES ('c5d6e7f8a9b0')")
        )
    monkeypatch.setattr(settings, "DATABASE_URL", url)
    backend = Path(__file__).resolve().parents[2]
    config = Config(str(backend / "alembic.ini"))
    config.set_main_option("script_location", str(backend / "alembic"))
    # Do not replace the test runner's logging configuration.
    config.config_file_name = None

    command.upgrade(config, TARGET_REVISION)

    with engine.connect() as connection:
        assert connection.execute(
            sa.text("SELECT raw_metadata FROM dingtalk_synced_nodes ORDER BY id")
        ).scalars().all() == [None, None]
    columns = {
        column["name"]
        for column in sa.inspect(engine).get_columns("dingtalk_synced_nodes")
    }
    assert "extension" not in columns
    table = sa.Table("dingtalk_synced_nodes", sa.MetaData(), autoload_with=engine)
    with engine.begin() as connection:
        connection.execute(
            table.update()
            .where(table.c.id == 1)
            .values(
                raw_metadata={"extension": "adoc", "unknown": {"values": [1, None]}}
            )
        )
        assert connection.execute(
            sa.select(table.c.raw_metadata).where(table.c.id == 1)
        ).scalar_one() == {"extension": "adoc", "unknown": {"values": [1, None]}}
    command.downgrade(config, "c5d6e7f8a9b0")
    assert "raw_metadata" not in {
        column["name"]
        for column in sa.inspect(engine).get_columns("dingtalk_synced_nodes")
    }
    with engine.connect() as connection:
        assert (
            connection.execute(
                sa.text("SELECT count(*) FROM dingtalk_synced_nodes")
            ).scalar_one()
            == 2
        )
    command.upgrade(config, TARGET_REVISION)
    engine.dispose()
