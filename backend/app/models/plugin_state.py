"""Durable identities and synchronization fences for account installations."""

from sqlalchemy import JSON, Column, DateTime, Integer, String, UniqueConstraint, func

from app.db.base import Base
from shared.models.db.types import big_integer_id_type


class PluginState(Base):
    """One independent synchronization document per user and canonical plugin."""

    __tablename__ = "plugin_states"

    id = Column(big_integer_id_type(), primary_key=True, autoincrement=True)
    user_id = Column(big_integer_id_type(), nullable=False)
    plugin_key = Column(String(100), nullable=False)
    installed_kind_id = Column(Integer, nullable=False, default=0, server_default="0")
    json = Column(JSON, nullable=False, default=dict)
    created_at = Column(DateTime, nullable=False, server_default=func.now())
    updated_at = Column(
        DateTime, nullable=False, server_default=func.now(), onupdate=func.now()
    )

    __table_args__ = (
        UniqueConstraint("user_id", "plugin_key", name="uniq_plugin_states_identity"),
        {
            "comment": "Plugin-scoped synchronization identities and transaction fences",
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_bin",
        },
    )
