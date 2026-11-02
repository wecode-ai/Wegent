"""Exercise identity backfill and subscription schema rollback on isolated data."""

import importlib.util
from pathlib import Path

import pytest
import sqlalchemy as sa
from pytest import MonkeyPatch
from sqlalchemy.dialects import mysql
from sqlalchemy.schema import CreateTable

from alembic.migration import MigrationContext
from alembic.operations import Operations
from app.models.issue_follower import IssueFollower


def test_mysql_subscription_defaults_match_microsecond_column_precision(
    monkeypatch: MonkeyPatch,
) -> None:
    path = (
        Path(__file__).parents[2]
        / "alembic/versions/20261030_a8b7c6d5e4f3_add_issue_followers.py"
    )
    spec = importlib.util.spec_from_file_location(
        "issue_identity_mysql_migration", path
    )
    assert spec is not None and spec.loader is not None
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    statements: list[str] = []
    engine = sa.create_mock_engine(
        "mysql+pymysql://",
        lambda statement, *args, **kwargs: statements.append(
            str(statement.compile(dialect=mysql.dialect()))
        ),
    )
    monkeypatch.setattr(migration, "op", Operations(MigrationContext.configure(engine)))

    migration._create_followers()

    for ddl in [
        *statements,
        str(CreateTable(IssueFollower.__table__).compile(dialect=mysql.dialect())),
    ]:
        if "CREATE TABLE" in ddl:
            assert "created_at DATETIME(6) NOT NULL DEFAULT now(6)" in ddl


@pytest.mark.parametrize("partial_column", [False, True])
def test_identity_upgrade_preserves_creators_and_rollback_preserves_issues(
    monkeypatch: MonkeyPatch,
    partial_column: bool,
) -> None:
    path = (
        Path(__file__).parents[2]
        / "alembic/versions/20261030_a8b7c6d5e4f3_add_issue_followers.py"
    )
    spec = importlib.util.spec_from_file_location("issue_identity_migration", path)
    assert spec is not None and spec.loader is not None
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    engine = sa.create_engine("sqlite://")
    with engine.begin() as connection:
        connection.exec_driver_sql("PRAGMA foreign_keys=ON")
        connection.exec_driver_sql(
            "CREATE TABLE loop_items (id VARCHAR(64) PRIMARY KEY, "
            "resource_type TEXT, created_by_user_id INTEGER)"
        )
        connection.exec_driver_sql(
            "INSERT INTO loop_items VALUES "
            "('issue-1','task',17),('issue-2','task',23),('project','project',31)"
        )
        operations = Operations(MigrationContext.configure(connection))
        monkeypatch.setattr(migration, "op", operations)
        if partial_column:
            operations.add_column(
                "loop_items", sa.Column("reporter_user_id", sa.Integer())
            )
            connection.exec_driver_sql(
                "UPDATE loop_items SET reporter_user_id=99 WHERE id='issue-1'"
            )

        migration.upgrade()

        assert connection.exec_driver_sql(
            "SELECT id,created_by_user_id,reporter_user_id FROM loop_items ORDER BY id"
        ).all() == [
            ("issue-1", 17, 99 if partial_column else 17),
            ("issue-2", 23, 23),
            ("project", 31, None),
        ]
        connection.exec_driver_sql(
            "INSERT INTO issue_followers(issue_id,user_id) VALUES ('issue-1',17)"
        )
        operations.drop_index("ix_issue_followers_user_issue", "issue_followers")
        migration.upgrade()
        assert (
            connection.exec_driver_sql(
                "SELECT COUNT(*) FROM issue_followers"
            ).scalar_one()
            == 1
        )
        assert any(
            index["name"] == "ix_issue_followers_user_issue"
            for index in sa.inspect(connection).get_indexes("issue_followers")
        )
        connection.exec_driver_sql("DELETE FROM loop_items WHERE id='issue-1'")
        assert (
            connection.exec_driver_sql(
                "SELECT COUNT(*) FROM issue_followers"
            ).scalar_one()
            == 0
        )

        migration.downgrade()

        inspector = sa.inspect(connection)
        assert "issue_followers" not in inspector.get_table_names()
        assert "reporter_user_id" not in {
            column["name"] for column in inspector.get_columns("loop_items")
        }
        assert connection.exec_driver_sql(
            "SELECT id,created_by_user_id FROM loop_items ORDER BY id"
        ).all() == [("issue-2", 23), ("project", 31)]
    engine.dispose()
