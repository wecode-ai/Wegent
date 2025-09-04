# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime, timezone, timedelta
from typing import Any

from sqlalchemy import Column, DateTime
from sqlalchemy.ext.declarative import as_declarative, declared_attr


@as_declarative()
class Base:
    id: Any
    __name__: str
    
    # Auto-generate table name
    @declared_attr
    def __tablename__(cls) -> str:
        return cls.__name__.lower()
    
    # Common fields
    created_at = Column(DateTime, default=lambda: datetime.now(timezone(timedelta(hours=8))))
    updated_at = Column(DateTime,
        default=lambda: datetime.now(timezone(timedelta(hours=8))),
        onupdate=lambda: datetime.now(timezone(timedelta(hours=8))))