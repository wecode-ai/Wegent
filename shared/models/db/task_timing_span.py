# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Task timing span database model."""

from sqlalchemy import (
    JSON,
    BigInteger,
    Column,
    DateTime,
    Index,
    String,
    UniqueConstraint,
)
from sqlalchemy.dialects import mysql
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.sql.expression import ColumnElement

from .base import Base

_DATETIME = DateTime().with_variant(mysql.DATETIME(fsp=6), "mysql")


class _AuditTimestampDefault(ColumnElement):
    """Render audited MySQL timestamp defaults without breaking SQLite tests."""

    inherit_cache = True
    type = DateTime()

    def __init__(self, *, on_update: bool = False) -> None:
        self.on_update = on_update


@compiles(_AuditTimestampDefault)
def _compile_timestamp_default(
    element: _AuditTimestampDefault, compiler, **kwargs
) -> str:
    return "CURRENT_TIMESTAMP"


@compiles(_AuditTimestampDefault, "mysql")
def _compile_mysql_timestamp_default(
    element: _AuditTimestampDefault, compiler, **kwargs
) -> str:
    value = "CURRENT_TIMESTAMP(6)"
    if element.on_update:
        value += " ON UPDATE CURRENT_TIMESTAMP(6)"
    return value


class TaskTimingSpan(Base):
    """A time interval observed during task execution."""

    __tablename__ = "task_timing_spans"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    task_id = Column(BigInteger, nullable=False)
    subtask_id = Column(BigInteger, nullable=True)
    parent_span_id = Column(String(100), nullable=False, default="", server_default="")
    span_id = Column(String(100), nullable=False)
    kind = Column(String(32), nullable=False)
    actor_id = Column(String(200), nullable=False, default="", server_default="")
    actor_type = Column(String(32), nullable=False, default="", server_default="")
    actor_label = Column(String(300), nullable=False, default="", server_default="")
    status = Column(
        String(24), nullable=False, default="running", server_default="running"
    )
    start_at_ms = Column(BigInteger)
    end_at_ms = Column(BigInteger)
    duration_ms = Column(BigInteger)
    clock = Column(String(64), nullable=False, default="", server_default="")
    source = Column(String(100), nullable=False, default="", server_default="")
    metadata_json = Column("metadata", JSON, nullable=False, default=dict)
    created_at = Column(
        _DATETIME,
        nullable=False,
        server_default=_AuditTimestampDefault(),
    )
    updated_at = Column(
        _DATETIME,
        nullable=False,
        server_default=_AuditTimestampDefault(on_update=True),
    )

    __table_args__ = (
        UniqueConstraint("span_id", name="uniq_task_timing_span_id"),
        Index("idx_task_timing_spans_task", "task_id", "start_at_ms", "id"),
        Index("idx_task_timing_spans_actor", "task_id", "actor_id", "start_at_ms"),
        Index("idx_task_timing_spans_kind", "task_id", "kind", "start_at_ms"),
    )
