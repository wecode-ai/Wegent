# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Persistent messages for one shared chat timeline per cloud project."""

from sqlalchemy import JSON, Column, DateTime, ForeignKey, Index, String, Text
from sqlalchemy.sql import func

from app.db.base import Base
from shared.models.db.types import big_integer_id_type


class ProjectChatMessage(Base):
    """One durable public message or agent response in a project chat."""

    __tablename__ = "project_chat_messages"

    id = Column(big_integer_id_type(), primary_key=True, autoincrement=True)
    message_id = Column(String(64), nullable=False, unique=True)
    client_message_id = Column(String(64), nullable=True)

    project_id = Column(
        String(64),
        ForeignKey("loop_items.id", ondelete="CASCADE"),
        nullable=False,
    )
    task_id = Column(
        String(64),
        ForeignKey("loop_items.id", ondelete="SET NULL"),
        nullable=True,
    )

    sender_type = Column(String(16), nullable=False)
    sender_id = Column(String(128), nullable=False)
    sender_name = Column(String(255), nullable=False)
    message_type = Column(String(32), nullable=False, default="text")
    content = Column(Text, nullable=False, default="")
    metadata_json = Column("metadata", JSON, nullable=True)

    trigger_message_id = Column(String(64), nullable=True)
    agent_id = Column(String(128), nullable=True)
    runtime_device_id = Column(String(255), nullable=True)
    runtime_task_id = Column(String(255), nullable=True)
    status = Column(String(16), nullable=False, default="completed")

    created_at = Column(DateTime, nullable=False, server_default=func.now())
    updated_at = Column(
        DateTime,
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )
    deleted_at = Column(DateTime, nullable=True)

    __table_args__ = (
        Index(
            "uq_project_chat_client_message",
            "sender_type",
            "sender_id",
            "client_message_id",
            unique=True,
        ),
        Index("ix_project_chat_project_order", "project_id", "id"),
        Index("ix_project_chat_task_order", "task_id", "id"),
        Index(
            "uq_project_chat_trigger_agent",
            "trigger_message_id",
            "agent_id",
            unique=True,
        ),
        Index(
            "ix_project_chat_runtime",
            "runtime_device_id",
            "runtime_task_id",
            "id",
        ),
        {"mysql_engine": "InnoDB", "mysql_charset": "utf8mb4"},
    )
