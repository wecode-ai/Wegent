"""Exercise the real Alembic upgrade and rollback without changing legacy history."""

from pathlib import Path

import sqlalchemy as sa

from alembic import command
from alembic.config import Config
from app.core.config import settings


def test_upgrade_head_and_rollback_preserve_history(tmp_path, monkeypatch):
    url = f"sqlite:///{tmp_path / 'experience.db'}"
    engine = sa.create_engine(url)
    metadata = sa.MetaData()
    table = sa.Table(
        "loop_items",
        metadata,
        sa.Column("id", sa.String, primary_key=True),
        sa.Column("resource_type", sa.String),
        sa.Column("status", sa.String),
        sa.Column("metadata", sa.JSON),
    )
    metadata.create_all(engine)
    original = {
        "workflow": {
            "advancement_policy": "ai",
            "orchestration_status": "running",
            "nodes": [{"id": "design"}],
        },
        "other": "retained",
    }
    rule = {"event_config": {"wework_flow": {"version": 2, "graph": {"nodes": []}}}}
    with engine.begin() as connection:
        connection.execute(
            table.insert(),
            [
                {
                    "id": "issue",
                    "resource_type": "task",
                    "status": "in_progress",
                    "metadata": original,
                },
                {
                    "id": "rule",
                    "resource_type": "automation_rule",
                    "status": "enabled",
                    "metadata": rule,
                },
            ],
        )
        connection.execute(
            sa.text(
                "CREATE TABLE alembic_version (version_num VARCHAR(32) PRIMARY KEY)"
            )
        )
        connection.execute(
            sa.text("INSERT INTO alembic_version VALUES ('f7b8c9d0e1a2')")
        )
    monkeypatch.setattr(settings, "DATABASE_URL", url)
    backend = Path(__file__).resolve().parents[2]
    config = Config(str(backend / "alembic.ini"))
    config.set_main_option("script_location", str(backend / "alembic"))
    config.config_file_name = None
    command.upgrade(config, "head")
    with engine.connect() as connection:
        rows = {
            row["id"]: row for row in connection.execute(sa.select(table)).mappings()
        }
    assert rows["rule"]["status"] == "disabled"
    assert rows["issue"]["metadata"]["workflow"]["orchestration_status"] == "paused"
    assert rows["issue"]["metadata"]["workflow"]["migration_required"] is True
    assert (
        rows["issue"]["metadata"]["workflow"]["nodes"] == original["workflow"]["nodes"]
    )
    assert "intent" not in rows["issue"]["metadata"]["workflow"]
    command.downgrade(config, "f7b8c9d0e1a2")
    with engine.connect() as connection:
        rows = {
            row["id"]: row for row in connection.execute(sa.select(table)).mappings()
        }
    assert rows["issue"]["metadata"] == original
    assert rows["rule"]["metadata"] == rule
    assert rows["rule"]["status"] == "enabled"
