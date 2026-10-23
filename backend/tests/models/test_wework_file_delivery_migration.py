# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Guarded, reversible updates of the built-in Wework delivery instructions."""

import importlib.util
import os
from copy import deepcopy
from pathlib import Path
from types import ModuleType
from typing import Any, Iterator

import pytest
import sqlalchemy as sa
from sqlalchemy.engine import Connection, RowMapping

from alembic.operations import Operations
from alembic.runtime.migration import MigrationContext

Storage = tuple[Connection, sa.Table]


@pytest.fixture
def migration() -> ModuleType:
    path = (
        Path(__file__).parents[2]
        / "alembic"
        / "versions"
        / "20261022_a9c4e7b2d610_correct_wework_file_delivery.py"
    )
    spec = importlib.util.spec_from_file_location("wework_delivery_migration", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def storage(
    migration: ModuleType, monkeypatch: pytest.MonkeyPatch
) -> Iterator[Storage]:
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
    with engine.begin() as connection:
        # A connection-local table shadows any real kinds table. Never mutate
        # seeded application resources, even when running the MySQL contract.
        kinds.create(connection)
        monkeypatch.setattr(
            migration, "op", Operations(MigrationContext.configure(connection))
        )
        yield connection, kinds
        kinds.drop(connection)
    engine.dispose()


def _payload(migration: ModuleType) -> dict[str, Any]:
    return {
        "metadata": {"labels": {"custom": "preserved"}},
        "spec": {
            "skills": ["mermaid-diagram"],
            "mcpServers": {"example": {"url": "https://example.test/mcp"}},
            "systemPrompt": (
                "Custom instructions before\n"
                + migration.OLD_WORKSPACE
                + "\n\n"
                + migration.OLD_FILE_RULES
                + "\nCustom instructions after"
            ),
        },
    }


def _insert(storage: Storage, payload: Any, **overrides: Any) -> None:
    connection, kinds = storage
    values = {
        "id": 1287,
        "user_id": 0,
        "kind": "Ghost",
        "name": "wegent-wework",
        "namespace": "default",
        "is_active": True,
        "json": payload,
    }
    values.update(overrides)
    connection.execute(kinds.insert().values(**values))


def test_preflight_is_read_only_scoped_and_does_not_disclose_prompts(
    storage: Storage, migration: ModuleType
) -> None:
    path = Path(__file__).parents[2] / "scripts/preflight_wework_file_delivery.py"
    spec = importlib.util.spec_from_file_location("artifact_preflight", path)
    assert spec and spec.loader
    preflight = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(preflight)
    _insert(storage, _payload(migration))
    _insert(
        storage,
        {"spec": {"systemPrompt": "private-custom-prompt"}},
        id=1288,
        is_active=False,
    )
    _insert(storage, _payload(migration), id=1289, user_id=1)
    connection, _ = storage
    statements: list[str] = []

    def record(_conn, _cursor, statement, _parameters, _context, _many):
        statements.append(statement)

    sa.event.listen(connection, "before_cursor_execute", record)
    try:
        report = preflight.inventory(connection)
        assert preflight.inventory(connection) == report
    finally:
        sa.event.remove(connection, "before_cursor_execute", record)
    assert all(
        statement.lstrip().upper().startswith("SELECT") for statement in statements
    )
    assert [(row["id"], row["classification"]) for row in report["rows"]] == [
        (1287, "legacy_exact"),
        (1288, "custom_or_unrecognized"),
    ]
    assert report["rows"][1]["is_active"] is False
    assert "private-custom-prompt" not in str(report)
    assert len(report["inventory_sha256"]) == 64


def _stored(storage: Storage) -> RowMapping:
    connection, kinds = storage
    return connection.execute(sa.select(kinds)).mappings().one()


def test_upgrade_and_downgrade_preserve_identity_and_unrelated_configuration(
    migration: ModuleType, storage: Storage
) -> None:
    original = _payload(migration)
    _insert(storage, original)

    migration.upgrade()
    upgraded = _stored(storage)
    expected = deepcopy(original)
    expected["spec"]["systemPrompt"] = (
        "Custom instructions before\n"
        + migration.NEW_WORKSPACE
        + "\n\n"
        + migration.MIGRATED_FILE_RULES
        + "\nCustom instructions after"
    )
    assert upgraded["id"] == 1287
    assert upgraded["json"] == expected
    assert "computer://" not in upgraded["json"]["spec"]["systemPrompt"]
    migration.upgrade()
    assert _stored(storage)["json"] == expected

    migration.downgrade()
    assert _stored(storage)["json"] == original
    migration.downgrade()
    assert _stored(storage)["json"] == original


def test_cp01_prompt_correction_issues_no_ddl_or_permission_writes(
    migration: ModuleType, storage: Storage
) -> None:
    _insert(storage, _payload(migration))
    connection, _ = storage
    statements: list[str] = []

    def capture(_connection, _cursor, statement, _parameters, _context, _many):
        statements.append(" ".join(statement.upper().split()))

    sa.event.listen(connection, "before_cursor_execute", capture)
    try:
        migration.upgrade()
        migration.downgrade()
    finally:
        sa.event.remove(connection, "before_cursor_execute", capture)

    assert len(statements) == 4
    assert all(
        statement.startswith("SELECT KINDS.")
        or statement.startswith("UPDATE KINDS SET JSON=")
        for statement in statements
    )


@pytest.mark.parametrize("direction", ["upgrade", "downgrade"])
@pytest.mark.parametrize("field", ["json", "namespace", "user_id", "is_active"])
def test_concurrent_configuration_changes_are_never_overwritten(
    migration: ModuleType, storage: Storage, direction: str, field: str
) -> None:
    _insert(storage, _payload(migration))
    if direction == "downgrade":
        migration.upgrade()
    connection, kinds = storage
    original = deepcopy(dict(_stored(storage)))
    changed = False

    def edit_before_update(_conn, _cursor, statement, _params, _context, _many):
        nonlocal changed
        if changed or not statement.lstrip().upper().startswith("UPDATE KINDS"):
            return
        changed = True
        values = {"namespace": "custom", "user_id": 42, "is_active": False}
        payload = deepcopy(original["json"])
        payload["spec"]["mcpServers"] = {
            "edited-concurrently": {"url": "https://example.test"}
        }
        values["json"] = payload
        connection.execute(
            kinds.update().where(kinds.c.id == 1287).values(**{field: values[field]})
        )

    sa.event.listen(connection, "before_cursor_execute", edit_before_update)
    try:
        with pytest.raises(RuntimeError, match="changed concurrently"):
            getattr(migration, direction)()
    finally:
        sa.event.remove(connection, "before_cursor_execute", edit_before_update)
    assert changed
    stored = dict(_stored(storage))
    assert stored[field] != original[field]
    assert {key: value for key, value in stored.items() if key != field} == {
        key: value for key, value in original.items() if key != field
    }


@pytest.mark.parametrize(
    "overrides",
    [
        {"user_id": 2},
        {"namespace": "custom"},
        {"name": "custom-agent"},
        {"kind": "Team"},
        {"is_active": False},
    ],
)
def test_upgrade_does_not_touch_other_resource_identities(
    migration: ModuleType, storage: Storage, overrides: dict[str, Any]
) -> None:
    original = _payload(migration)
    _insert(storage, original, **overrides)

    migration.upgrade()
    migration.downgrade()

    assert _stored(storage)["json"] == original


@pytest.mark.parametrize("section", ["OLD_FILE_RULES", "OLD_WORKSPACE"])
def test_upgrade_preserves_customized_delivery_sections(
    migration: ModuleType, storage: Storage, section: str
) -> None:
    original = _payload(migration)
    original["spec"]["systemPrompt"] = original["spec"]["systemPrompt"].replace(
        getattr(migration, section), "Administrator-customized delivery policy"
    )
    _insert(storage, original)

    migration.upgrade()

    assert _stored(storage)["json"] == original


def test_downgrade_does_not_modify_fresh_install_prompt(
    migration: ModuleType, storage: Storage
) -> None:
    original = _payload(migration)
    original["spec"]["systemPrompt"] = (
        migration.NEW_WORKSPACE + "\n\n" + migration.NEW_FILE_RULES
    )
    _insert(storage, original)

    migration.downgrade()

    assert _stored(storage)["json"] == original


def test_downgrade_preserves_rules_customized_after_upgrade(
    migration: ModuleType, storage: Storage
) -> None:
    _insert(storage, _payload(migration))
    migration.upgrade()
    connection, kinds = storage
    customized = deepcopy(_stored(storage)["json"])
    customized["spec"]["systemPrompt"] = customized["spec"]["systemPrompt"].replace(
        migration.MIGRATED_FILE_RULES, "New administrator-customized delivery policy"
    )
    connection.execute(kinds.update().values(json=customized))

    migration.downgrade()

    assert _stored(storage)["json"] == customized


@pytest.mark.parametrize(
    "payload", [None, [], {"spec": None}, {"spec": {"systemPrompt": 7}}]
)
def test_upgrade_ignores_malformed_or_missing_prompts(
    migration: ModuleType, storage: Storage, payload: Any
) -> None:
    _insert(storage, payload)

    migration.upgrade()
    migration.downgrade()

    assert _stored(storage)["json"] == payload
