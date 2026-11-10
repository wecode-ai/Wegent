"""Durable local plugin operations and asynchronous cloud-device dispatch."""

from datetime import datetime

from sqlalchemy import JSON, Column, DateTime, Index, Integer, String, UniqueConstraint
from sqlalchemy.dialects import mysql

from app.db.base import Base
from shared.models.db.types import big_integer_id_type

_DATETIME = DateTime().with_variant(mysql.DATETIME(fsp=6), "mysql")


class PluginLocalSyncOperation(Base):
    __tablename__ = "plugin_local_sync_operations"

    id = Column(big_integer_id_type(), primary_key=True, autoincrement=True)
    user_id = Column(big_integer_id_type(), nullable=False)
    instance_id = Column(String(128), nullable=False)
    operation_id = Column(String(128), nullable=False)
    request_hash = Column(String(64), nullable=False, default="", server_default="")
    action = Column(String(20), nullable=False)
    installed_id = Column(
        big_integer_id_type(), nullable=False, default=0, server_default="0"
    )
    document = Column(JSON, nullable=False, default=dict)
    created_at = Column(_DATETIME, nullable=False, default=datetime.utcnow)
    updated_at = Column(_DATETIME, nullable=False, default=datetime.utcnow)

    __table_args__ = (
        UniqueConstraint(
            "user_id", "instance_id", "operation_id", name="uniq_plugin_local_operation"
        ),
        Index("idx_plugin_local_instance", "user_id", "instance_id", "action"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_bin",
        },
    )


class PluginSyncOutbox(Base):
    __tablename__ = "plugin_sync_outbox"

    id = Column(big_integer_id_type(), primary_key=True, autoincrement=True)
    user_id = Column(big_integer_id_type(), nullable=False)
    instance_id = Column(String(128), nullable=False)
    installed_id = Column(big_integer_id_type(), nullable=False)
    operation_id = Column(String(128), nullable=False)
    action = Column(String(20), nullable=False)
    state = Column(
        String(16), nullable=False, default="pending", server_default="pending"
    )
    claim_token = Column(String(64), nullable=False, default="", server_default="")
    attempt_count = Column(Integer, nullable=False, default=0, server_default="0")
    next_attempt_at = Column(_DATETIME, nullable=False, default=datetime.utcnow)
    lease_until = Column(_DATETIME, nullable=False, default=datetime.utcnow)
    created_at = Column(_DATETIME, nullable=False, default=datetime.utcnow)
    updated_at = Column(_DATETIME, nullable=False, default=datetime.utcnow)

    __table_args__ = (
        UniqueConstraint(
            "user_id", "instance_id", "operation_id", name="uniq_plugin_sync_event"
        ),
        Index("idx_plugin_sync_pending", "state", "next_attempt_at"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_bin",
        },
    )
