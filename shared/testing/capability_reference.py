# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Database setup for capability-reference contract tests."""

from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from dataclasses import dataclass

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

from shared.models.db import Kind


@dataclass(frozen=True)
class CapabilityReferenceDatabase:
    """Tables and session used by capability-reference tests."""

    session: Session
    namespace: Table
    resource_members: Table


@contextmanager
def capability_reference_database(
    additional_tables: Sequence[Table] = (),
) -> Iterator[CapabilityReferenceDatabase]:
    """Create an isolated in-memory capability-reference database."""
    engine = create_engine("sqlite:///:memory:")
    Kind.__table__.create(engine)
    for orm_table in additional_tables:
        orm_table.create(engine)

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

    try:
        with Session(engine) as session:
            yield CapabilityReferenceDatabase(
                session=session,
                namespace=namespace,
                resource_members=resource_members,
            )
    finally:
        engine.dispose()
