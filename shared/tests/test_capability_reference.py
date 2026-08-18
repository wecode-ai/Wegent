# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Behavior tests for resolving visible capability references."""

from sqlalchemy import (
    Boolean,
    Column,
    Integer,
    MetaData,
    String,
    Table,
    create_engine,
)
from sqlalchemy.orm import Session

from shared.db.capability_reference import resolve_referenced_model_kind
from shared.models.db import Kind


def _create_schema(engine) -> tuple[Table, Table]:
    Kind.__table__.create(engine)
    metadata = MetaData()
    namespace = Table(
        "namespace",
        metadata,
        Column("id", Integer, primary_key=True),
        Column("name", String(100), nullable=False),
        Column("is_active", Boolean, nullable=False),
    )
    resource_members = Table(
        "resource_members",
        metadata,
        Column("id", Integer, primary_key=True),
        Column("resource_type", String(50), nullable=False),
        Column("resource_id", Integer, nullable=False),
        Column("entity_type", String(20), nullable=False),
        Column("entity_id", String(100), nullable=False),
        Column("status", String(20), nullable=False),
    )
    metadata.create_all(engine)
    return namespace, resource_members


def test_group_model_reference_requires_active_target_source_and_binding() -> None:
    engine = create_engine("sqlite:///:memory:")
    namespace, resource_members = _create_schema(engine)

    with Session(engine) as db:
        source = Kind(
            id=101,
            user_id=42,
            kind="Model",
            name="shared-embedding",
            namespace="default",
            json={"spec": {"protocol": "openai"}},
            is_active=True,
        )
        db.add(source)
        db.execute(
            namespace.insert().values(
                id=7,
                name="search-team",
                is_active=True,
            )
        )
        db.execute(
            resource_members.insert().values(
                id=1,
                resource_type="Model",
                resource_id=source.id,
                entity_type="namespace",
                entity_id="7",
                status="approved",
            )
        )
        db.commit()

        resolved = resolve_referenced_model_kind(
            db,
            name="shared-embedding",
            namespace="search-team",
            user_id=99,
        )

        assert resolved is not None
        assert resolved.id == source.id
        assert resolved.namespace == "default"

        db.execute(
            namespace.update().where(namespace.c.id == 7).values(is_active=False)
        )
        db.commit()

        inactive_target = resolve_referenced_model_kind(
            db,
            name="shared-embedding",
            namespace="search-team",
            user_id=99,
        )

        assert inactive_target is None

        db.execute(namespace.update().where(namespace.c.id == 7).values(is_active=True))
        source.is_active = False
        db.commit()

        inactive_source = resolve_referenced_model_kind(
            db,
            name="shared-embedding",
            namespace="search-team",
            user_id=99,
        )

        assert inactive_source is None

        source.is_active = True
        db.execute(resource_members.delete().where(resource_members.c.id == 1))
        db.commit()

        revoked = resolve_referenced_model_kind(
            db,
            name="shared-embedding",
            namespace="search-team",
            user_id=99,
        )

        assert revoked is None
