# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Withdrawing the prompt revision must never rewrite Ghost or version data."""

import os
from pathlib import Path
from typing import Any, Iterator

import pytest
import sqlalchemy as sa
from sqlalchemy.engine import Connection

from alembic.config import Config
from alembic.operations import Operations
from alembic.runtime.migration import MigrationContext
from alembic.script import ScriptDirectory
from alembic.util import CommandError

REVISION = "a9c4e7b2d610"
PREDECESSOR = "f3a7c9e1b2d4"
DEVICE_INDEX_REVISION = "a2d59b84f731"
DEVICE_INDEX = "ix_subtasks_user_executor_status"
VERSION_TABLE = "artifact_retired_revision_test"


@pytest.fixture
def scripts() -> ScriptDirectory:
    config = Config(str(Path(__file__).parents[2] / "alembic.ini"))
    config.set_main_option(
        "script_location", str(Path(__file__).parents[2] / "alembic")
    )
    return ScriptDirectory.from_config(config)


@pytest.fixture
def storage() -> Iterator[tuple[Connection, sa.Table]]:
    engine = sa.create_engine(
        os.environ.get("WEGENT_MIGRATION_TEST_DATABASE_URL", "sqlite://")
    )
    metadata = sa.MetaData()
    kinds = sa.Table(
        "kinds",
        metadata,
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("user_id", sa.Integer),
        sa.Column("kind", sa.String(64)),
        sa.Column("name", sa.String(255)),
        sa.Column("namespace", sa.String(255)),
        sa.Column("is_active", sa.Boolean),
        sa.Column("json", sa.JSON),
        prefixes=["TEMPORARY"],
    )
    subtasks = sa.Table(
        "subtasks",
        metadata,
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("user_id", sa.Integer),
        sa.Column("executor_name", sa.String(100)),
        sa.Column("status", sa.String(32)),
        prefixes=["TEMPORARY"],
    )
    versions = sa.Table(
        VERSION_TABLE,
        metadata,
        sa.Column("version_num", sa.String(32), primary_key=True),
        prefixes=["TEMPORARY"],
    )
    with engine.begin() as connection:
        # Use connection-local tables, independent of application data.
        kinds.create(connection)
        subtasks.create(connection)
        versions.create(connection)
        try:
            yield connection, kinds
        finally:
            versions.drop(connection)
            subtasks.drop(connection)
            kinds.drop(connection)
    engine.dispose()


def test_withdrawn_revision_is_absent_from_the_version_chain(
    scripts: ScriptDirectory,
) -> None:
    assert scripts.get_heads() == [DEVICE_INDEX_REVISION]
    assert scripts.get_revision(DEVICE_INDEX_REVISION).down_revision == PREDECESSOR
    assert not list(Path(scripts.versions).glob(f"*{REVISION}*"))
    with pytest.raises(CommandError, match=REVISION):
        scripts.get_revision(REVISION)


def _payload(prompt_kind: str) -> dict[str, Any]:
    legacy = (
        Path(__file__).parents[1] / "fixtures/wework_legacy_file_delivery.txt"
    ).read_text(encoding="utf-8")
    prompts = {
        "legacy": legacy,
        "migrated": "<!-- Migrated by a9c4e7b2d610. -->\nUse artifact cards.",
        "custom": "Administrator-customized instructions: leave them unchanged.",
        "fresh": "Declare final deliverables with artifact declare --path.",
    }
    return {
        "metadata": {"labels": {"custom": "preserved"}},
        "spec": {
            "systemPrompt": prompts[prompt_kind],
            "skills": ["mermaid-diagram"],
            "mcpServers": {"example": {"url": "https://example.test/mcp"}},
        },
    }


def _advance(
    connection: Connection, scripts: ScriptDirectory, target: str, direction: str
) -> None:
    def migrations(revisions: tuple[str, ...], _context: MigrationContext):
        if direction == "upgrade":
            return scripts._upgrade_revs(target, revisions)
        return scripts._downgrade_revs(target, revisions)

    context = MigrationContext.configure(
        connection, opts={"version_table": VERSION_TABLE, "fn": migrations}
    )
    with Operations.context(context):
        context.run_migrations()
    assert context.get_current_revision() == (
        DEVICE_INDEX_REVISION if target == "head" else target
    )


@pytest.mark.parametrize("starting_revision", [PREDECESSOR, REVISION])
@pytest.mark.parametrize("prompt_kind", ["legacy", "migrated", "custom", "fresh"])
def test_upgrade_and_rollback_preserve_prompts_and_reject_withdrawn_version(
    scripts: ScriptDirectory,
    storage: tuple[Connection, sa.Table],
    starting_revision: str,
    prompt_kind: str,
) -> None:
    connection, kinds = storage
    connection.execute(
        kinds.insert().values(
            id=1287,
            user_id=0,
            kind="Ghost",
            name="wegent-wework",
            namespace="default",
            is_active=True,
            json=_payload(prompt_kind),
        )
    )
    context = MigrationContext.configure(
        connection, opts={"version_table": VERSION_TABLE}
    )
    # Model already-recorded versions without stamping an unknown revision.
    connection.execute(context._version.insert().values(version_num=starting_revision))
    before = dict(connection.execute(sa.select(kinds)).mappings().one())
    statements: list[str] = []

    def capture(_connection, _cursor, statement, _parameters, _context, _many):
        statements.append(" ".join(statement.upper().split()))

    sa.event.listen(connection, "before_cursor_execute", capture)
    try:
        for target, direction in [
            ("head", "upgrade"),
            (PREDECESSOR, "downgrade"),
            ("head", "upgrade"),
        ]:

            if starting_revision == REVISION:
                with pytest.raises(CommandError, match=REVISION):
                    _advance(connection, scripts, target, direction)
            else:
                _advance(connection, scripts, target, direction)
    finally:
        sa.event.remove(connection, "before_cursor_execute", capture)
    assert dict(connection.execute(sa.select(kinds)).mappings().one()) == before
    assert context.get_current_revision() == (
        DEVICE_INDEX_REVISION if starting_revision == PREDECESSOR else starting_revision
    )
    assert statements
    data_statements = [
        statement
        for statement in statements
        if not statement.startswith(("CREATE INDEX ", "DROP INDEX "))
    ]
    assert data_statements
    assert all(VERSION_TABLE.upper() in statement for statement in data_statements)
    assert not any("KINDS" in statement for statement in statements)
    index_statements = [
        statement
        for statement in statements
        if statement.startswith(("CREATE INDEX ", "DROP INDEX "))
    ]
    if starting_revision == PREDECESSOR:
        create_index = f"CREATE INDEX {DEVICE_INDEX.upper()} ON SUBTASKS (USER_ID, EXECUTOR_NAME, STATUS)"
        drop_index = f"DROP INDEX {DEVICE_INDEX.upper()}"
        if connection.dialect.name == "mysql":
            drop_index += " ON SUBTASKS"
        assert index_statements == [create_index, drop_index, create_index]
    else:
        assert index_statements == []
