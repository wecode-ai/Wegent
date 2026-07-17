# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Internal agent task usage detail model."""

from sqlalchemy import (
    BigInteger,
    Column,
    DateTime,
    Index,
    Integer,
    String,
    UniqueConstraint,
)
from sqlalchemy.sql import func

from app.db.base import Base


class AgentTaskUsageDetail(Base):
    """Offline-imported task usage facts, one row per task."""

    __tablename__ = "agent_task_usage_detail"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    task_id = Column(BigInteger, nullable=False, server_default="0")
    visitor_user_id = Column(BigInteger, nullable=False, server_default="0")
    task_name = Column(String(128), nullable=False, server_default="")
    agent_name = Column(String(255), nullable=False, server_default="")
    agent_namespace = Column(String(128), nullable=False, server_default="")
    agent_user_id = Column(BigInteger, nullable=False, server_default="0")
    task_created_at = Column(DateTime, nullable=False, server_default=func.now())
    ai_rounds = Column(Integer, nullable=False, server_default="0")
    completed_ai_rounds = Column(Integer, nullable=False, server_default="0")

    __table_args__ = (
        UniqueConstraint("task_id", name="uniq_task_id"),
        Index(
            "idx_agent_time",
            "agent_namespace",
            "agent_user_id",
            "agent_name",
            "task_created_at",
        ),
        Index("idx_time_visitor", "task_created_at", "visitor_user_id"),
        {"mysql_engine": "InnoDB", "mysql_charset": "utf8mb4"},
    )
