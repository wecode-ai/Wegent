# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from pathlib import Path

import pytest
import sqlalchemy as sa

from alembic import command
from alembic.config import Config


@pytest.fixture
def migration_config(tmp_path, monkeypatch):
    from app.core.config import settings

    url = f"sqlite:///{tmp_path / 'task-timing-spans.db'}"
    monkeypatch.setattr(settings, "DATABASE_URL", url)

    backend = Path(__file__).parents[2]
    config = Config(str(backend / "alembic.ini"))
    config.set_main_option("script_location", str(backend / "alembic"))
    config.set_main_option("sqlalchemy.url", url)
    # Do not replace the test runner's logging configuration.
    config.config_file_name = None
    return config


def test_task_timing_spans_upgrade_and_downgrade(migration_config):
    database_url = migration_config.get_main_option("sqlalchemy.url")
    engine = sa.create_engine(database_url)
    with engine.begin() as connection:
        connection.execute(
            sa.text(
                "CREATE TABLE alembic_version (version_num VARCHAR(32) NOT NULL PRIMARY KEY)"
            )
        )
        connection.execute(
            sa.text("INSERT INTO alembic_version (version_num) VALUES ('b1c2d3e4f5a6')")
        )

    command.stamp(migration_config, "b1c2d3e4f5a6")
    command.upgrade(migration_config, "c2d3e4f5a6b7")
    inspector = sa.inspect(engine)
    assert "task_timing_spans" in inspector.get_table_names()

    command.downgrade(migration_config, "b1c2d3e4f5a6")
    inspector = sa.inspect(engine)
    assert "task_timing_spans" not in inspector.get_table_names()
    engine.dispose()
