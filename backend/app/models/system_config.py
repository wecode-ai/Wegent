# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
SystemConfig model for storing system-wide configurations like quick access recommendations.
"""

import json
from datetime import datetime
from typing import Any, Dict, Optional

from sqlalchemy import Column, DateTime, Integer, String
from sqlalchemy.sql import func

from app.db.base import Base


class SystemConfig(Base):
    """
    System configuration model for storing key-value configurations.
    Used for features like system-recommended quick access teams.
    The config_value is stored as JSON string in VARCHAR(4096).
    """

    __tablename__ = "system_configs"

    id = Column(Integer, primary_key=True, index=True)
    config_key = Column(String(100), nullable=False, unique=True, index=True)
    _config_value = Column("config_value", String(4096), nullable=False, default="{}")
    version = Column(Integer, nullable=False, default=1)
    updated_by = Column(Integer, nullable=True)  # User ID who last updated
    created_at = Column(DateTime, default=func.now())
    updated_at = Column(DateTime, default=func.now(), onupdate=func.now())

    __table_args__ = (
        {
            "sqlite_autoincrement": True,
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )

    @property
    def config_value(self) -> Optional[Dict[str, Any]]:
        """Get config_value as a dictionary."""
        if self._config_value:
            try:
                return json.loads(self._config_value)
            except (json.JSONDecodeError, TypeError):
                return {}
        return {}

    @config_value.setter
    def config_value(self, value: Optional[Dict[str, Any]]) -> None:
        """Set config_value from a dictionary."""
        if value is None:
            self._config_value = "{}"
        else:
            self._config_value = json.dumps(value, ensure_ascii=False)
