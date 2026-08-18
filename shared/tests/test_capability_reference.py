# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Behavior tests for resolving visible Model references."""

from collections.abc import Iterator
from dataclasses import dataclass

import pytest
from sqlalchemy import Table
from sqlalchemy.orm import Session

from shared.db.capability_reference import resolve_referenced_model_kind
from shared.models.db import Kind
from shared.tests._capability_reference_support import (
    capability_reference_database,
)


@dataclass(frozen=True)
class ModelReferenceScenario:
    """Seeded Model reference and its mutable database records."""

    db: Session
    source: Kind
    namespace: Table
    resource_members: Table


@pytest.fixture
def model_reference() -> Iterator[ModelReferenceScenario]:
    """Create one active group reference to an active Model."""
    with capability_reference_database() as database:
        source = Kind(
            id=101,
            user_id=42,
            kind="Model",
            name="shared-embedding",
            namespace="default",
            json={"spec": {"protocol": "openai"}},
            is_active=True,
        )
        database.session.add(source)
        database.session.execute(
            database.namespace.insert().values(
                id=7,
                name="search-team",
                is_active=True,
            )
        )
        database.session.execute(
            database.resource_members.insert().values(
                id=1,
                resource_type="Model",
                resource_id=source.id,
                entity_type="namespace",
                entity_id="7",
                status="approved",
            )
        )
        database.session.commit()
        yield ModelReferenceScenario(
            db=database.session,
            source=source,
            namespace=database.namespace,
            resource_members=database.resource_members,
        )


def _resolve_model(scenario: ModelReferenceScenario) -> Kind | None:
    return resolve_referenced_model_kind(
        scenario.db,
        name="shared-embedding",
        namespace="search-team",
        user_id=99,
    )


def _add_same_name_source(
    scenario: ModelReferenceScenario,
    *,
    source_id: int,
) -> Kind:
    source = Kind(
        id=source_id,
        user_id=43,
        kind="Model",
        name="shared-embedding",
        namespace="default",
        json={"spec": {"protocol": "openai"}},
        is_active=True,
    )
    scenario.db.add(source)
    return source


def _bind_source(
    scenario: ModelReferenceScenario,
    *,
    binding_id: int,
    source_id: int,
    entity_type: str,
    entity_id: str,
) -> None:
    scenario.db.execute(
        scenario.resource_members.insert().values(
            id=binding_id,
            resource_type="Model",
            resource_id=source_id,
            entity_type=entity_type,
            entity_id=entity_id,
            status="approved",
        )
    )


def test_group_model_reference_resolves_source(
    model_reference: ModelReferenceScenario,
) -> None:
    resolved = _resolve_model(model_reference)

    assert resolved is not None
    assert resolved.id == model_reference.source.id
    assert resolved.namespace == "default"


def test_group_model_reference_prefers_smallest_source_id(
    model_reference: ModelReferenceScenario,
) -> None:
    oldest = _add_same_name_source(model_reference, source_id=100)
    _bind_source(
        model_reference,
        binding_id=2,
        source_id=oldest.id,
        entity_type="namespace",
        entity_id="7",
    )
    model_reference.db.commit()

    resolved = _resolve_model(model_reference)

    assert resolved is not None
    assert resolved.id == oldest.id


def test_personal_model_reference_prefers_smallest_source_id(
    model_reference: ModelReferenceScenario,
) -> None:
    oldest = _add_same_name_source(model_reference, source_id=100)
    _bind_source(
        model_reference,
        binding_id=2,
        source_id=model_reference.source.id,
        entity_type="user",
        entity_id="99",
    )
    _bind_source(
        model_reference,
        binding_id=3,
        source_id=oldest.id,
        entity_type="user",
        entity_id="99",
    )
    model_reference.db.commit()

    resolved = resolve_referenced_model_kind(
        model_reference.db,
        name="shared-embedding",
        namespace="default",
        user_id=99,
    )

    assert resolved is not None
    assert resolved.id == oldest.id


def test_group_model_reference_requires_active_namespace(
    model_reference: ModelReferenceScenario,
) -> None:
    model_reference.db.execute(
        model_reference.namespace.update()
        .where(model_reference.namespace.c.id == 7)
        .values(is_active=False)
    )
    model_reference.db.commit()

    resolved = _resolve_model(model_reference)

    assert resolved is None


def test_group_model_reference_requires_active_source(
    model_reference: ModelReferenceScenario,
) -> None:
    model_reference.source.is_active = False
    model_reference.db.commit()

    resolved = _resolve_model(model_reference)

    assert resolved is None


def test_group_model_reference_requires_existing_binding(
    model_reference: ModelReferenceScenario,
) -> None:
    model_reference.db.execute(
        model_reference.resource_members.delete().where(
            model_reference.resource_members.c.id == 1
        )
    )
    model_reference.db.commit()

    resolved = _resolve_model(model_reference)

    assert resolved is None
