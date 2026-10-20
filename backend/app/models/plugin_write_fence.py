"""Durable ownership fence for Redis-coordinated plugin transactions."""

from sqlalchemy import BigInteger, Column, String

from app.db.base import Base


class PluginWriteFence(Base):
    __tablename__ = "plugin_write_fences"

    user_id = Column(BigInteger, primary_key=True, autoincrement=False)
    token = Column(String(64), nullable=False)
