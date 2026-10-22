# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Guarded, reversible updates of the built-in Wework delivery instructions."""

import importlib.util
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
    engine = sa.create_engine("sqlite://")
    metadata = sa.MetaData()
    kinds = sa.Table(
        "kinds",
        metadata,
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("user_id", sa.Integer),
        sa.Column("kind", sa.String),
        sa.Column("name", sa.String),
        sa.Column("namespace", sa.String),
        sa.Column("is_active", sa.Boolean),
        sa.Column("json", sa.JSON),
    )
    metadata.create_all(engine)
    with engine.begin() as connection:
        monkeypatch.setattr(
            migration, "op", Operations(MigrationContext.configure(connection))
        )
        yield connection, kinds
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
