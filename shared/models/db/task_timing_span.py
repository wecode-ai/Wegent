# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Task timing span database model."""

from sqlalchemy import JSON, BigInteger, Column, DateTime, Index, String
from sqlalchemy.sql import func

from .base import Base


class TaskTimingSpan(Base):
    """A time interval observed during task execution."""

    __tablename__ = "task_timing_spans"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    task_id = Column(BigInteger, nullable=False)
    subtask_id = Column(BigInteger, nullable=True)
    turn_id = Column(String(100), nullable=False, default="")
    parent_span_id = Column(String(100), nullable=False, default="")
    span_id = Column(String(100), nullable=False, unique=True)
    kind = Column(String(32), nullable=False)
    actor_id = Column(String(200), nullable=False, default="")
    actor_type = Column(String(32), nullable=False, default="")
    actor_label = Column(String(300), nullable=False, default="")
    status = Column(String(24), nullable=False, default="running")
    start_at_ms = Column(BigInteger)
    end_at_ms = Column(BigInteger)
    duration_ms = Column(BigInteger)
    clock = Column(String(64), nullable=False, default="")
    source = Column(String(100), nullable=False, default="")
    metadata_json = Column("metadata", JSON, nullable=False, default=dict)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        Index("idx_task_timing_spans_task", "task_id", "start_at_ms", "id"),
        Index("idx_task_timing_spans_actor", "task_id", "actor_id", "start_at_ms"),
        Index("idx_task_timing_spans_kind", "task_id", "kind", "start_at_ms"),
    )
