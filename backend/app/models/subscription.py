# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Subscription models for Smart Feed feature
"""
from datetime import datetime
from enum import Enum

from sqlalchemy import (
    JSON,
    Boolean,
    Column,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
)
from sqlalchemy.orm import relationship

from app.db.base import Base


class TriggerType(str, Enum):
    """Trigger type for subscription"""

    CRON = "cron"
    WEBHOOK = "webhook"


class SubscriptionRunStatus(str, Enum):
    """Status for subscription run"""

    PENDING = "pending"
    RUNNING = "running"
    SUCCESS = "success"
    FAILED = "failed"


class Subscription(Base):
    """Subscription model for scheduled agent tasks"""

    __tablename__ = "subscriptions"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, nullable=False, index=True)
    namespace = Column(String(100), nullable=False, default="default")
    name = Column(String(100), nullable=False)
    description = Column(Text, nullable=True)

    # Team reference
    team_id = Column(Integer, nullable=False)
    team_name = Column(String(100), nullable=False)
    team_namespace = Column(String(100), nullable=False, default="default")

    # Trigger configuration
    trigger_type = Column(String(20), nullable=False, default="cron")
    cron_expression = Column(String(100), nullable=True)
    cron_timezone = Column(String(50), nullable=True, default="Asia/Shanghai")
    webhook_secret = Column(String(100), nullable=True)

    # Alert policy
    alert_enabled = Column(Boolean, default=True)
    alert_prompt = Column(Text, nullable=True)
    alert_keywords = Column(JSON, nullable=True)

    # Retention policy
    retention_days = Column(Integer, default=30)

    # Status
    enabled = Column(Boolean, default=True)
    last_run_time = Column(DateTime, nullable=True)
    last_run_status = Column(String(20), nullable=True)
    unread_count = Column(Integer, default=0)
    total_item_count = Column(Integer, default=0)

    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.now)
    updated_at = Column(DateTime, default=datetime.now, onupdate=datetime.now)

    # Relationships
    items = relationship(
        "SubscriptionItem", back_populates="subscription", lazy="dynamic"
    )
    runs = relationship(
        "SubscriptionRun", back_populates="subscription", lazy="dynamic"
    )

    __table_args__ = (
        {"mysql_charset": "utf8mb4", "mysql_collate": "utf8mb4_unicode_ci"},
    )


class SubscriptionItem(Base):
    """Subscription item model for collected information"""

    __tablename__ = "subscription_items"

    id = Column(Integer, primary_key=True, index=True)
    subscription_id = Column(
        Integer, ForeignKey("subscriptions.id"), nullable=False, index=True
    )
    title = Column(String(500), nullable=False)
    content = Column(Text, nullable=True)
    summary = Column(Text, nullable=True)
    source_url = Column(String(1000), nullable=True)
    item_metadata = Column(JSON, nullable=True)

    # Alert status
    should_alert = Column(Boolean, default=False)
    alert_reason = Column(String(500), nullable=True)

    # Read status
    is_read = Column(Boolean, default=False)

    # Task reference
    task_id = Column(Integer, nullable=True)
    run_id = Column(Integer, ForeignKey("subscription_runs.id"), nullable=True)

    created_at = Column(DateTime, default=datetime.now)

    # Relationships
    subscription = relationship("Subscription", back_populates="items")

    __table_args__ = (
        {"mysql_charset": "utf8mb4", "mysql_collate": "utf8mb4_unicode_ci"},
    )


class SubscriptionRun(Base):
    """Subscription run model for execution history"""

    __tablename__ = "subscription_runs"

    id = Column(Integer, primary_key=True, index=True)
    subscription_id = Column(
        Integer, ForeignKey("subscriptions.id"), nullable=False, index=True
    )
    task_id = Column(Integer, nullable=True)
    status = Column(String(20), nullable=False, default="pending")
    items_collected = Column(Integer, default=0)
    items_alerted = Column(Integer, default=0)
    started_at = Column(DateTime, nullable=True)
    finished_at = Column(DateTime, nullable=True)
    error_message = Column(Text, nullable=True)

    # Relationships
    subscription = relationship("Subscription", back_populates="runs")
    items = relationship("SubscriptionItem", backref="run", lazy="dynamic")

    __table_args__ = (
        {"mysql_charset": "utf8mb4", "mysql_collate": "utf8mb4_unicode_ci"},
    )
