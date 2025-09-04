# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime
from sqlalchemy import Column, Integer, String, Text, Boolean, DateTime, JSON, ForeignKey
from sqlalchemy.sql import func
from sqlalchemy.orm import relationship

from app.db.base import Base

class Bot(Base):
    __tablename__ = "bots"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    k_id = Column(Integer, unique=True, index=True)
    name = Column(String(100), nullable=False)
    agent_name = Column(String(100), nullable=False)
    agent_config = Column(JSON, nullable=False)
    system_prompt = Column(Text)
    mcp_servers = Column(JSON)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=func.now())
    updated_at = Column(DateTime, default=func.now(), onupdate=func.now())

    # Relationships
    user = relationship("User", back_populates="bots")

    __table_args__ = (
        {'sqlite_autoincrement': True,
         'mysql_engine': 'InnoDB',
         'mysql_charset': 'utf8mb4',
         'mysql_collate': 'utf8mb4_unicode_ci'},
    )