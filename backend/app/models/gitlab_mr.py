# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""GitLab MR integration registrations and per-MR fix-task state.

``mr_integrations`` records one webhook registration per cloud project (one
repo per project). ``mr_records`` tracks each MR's cross-event state machine:
rounds are keyed by head SHA and accumulate in ``rounds_json`` so a card can
carry a summary of previous fix attempts. Both tables follow the production
MySQL sentinel rules (every non-PK column NOT NULL, explicit defaults, no FKs).
"""

from datetime import datetime

from sqlalchemy import (
    JSON,
    Boolean,
    Column,
    DateTime,
    Index,
    Integer,
    String,
    UniqueConstraint,
    func,
)

from app.db.base import Base
from shared.models.db.types import big_integer_id_type

EPOCH_TIME = datetime(1970, 1, 1, 0, 0, 0)


class MRIntegration(Base):
    """One GitLab MR webhook registration for a cloud project."""

    __tablename__ = "mr_integrations"

    id = Column(big_integer_id_type(), primary_key=True, autoincrement=True)
    cloud_project_id = Column(String(64), nullable=False, default="", server_default="")
    project_key = Column(String(16), nullable=False, default="", server_default="")
    repository = Column(String(255), nullable=False, default="", server_default="")
    domain = Column(String(255), nullable=False, default="", server_default="")
    api_base = Column(String(255), nullable=False, default="", server_default="")
    # URL path token that routes inbound webhooks to this registration.
    webhook_token = Column(String(64), nullable=False, default="", server_default="")
    # Shared secret sent by GitLab in the X-Gitlab-Token header.
    webhook_secret = Column(String(128), nullable=False, default="", server_default="")
    gitlab_hook_id = Column(
        big_integer_id_type(), nullable=False, default=0, server_default="0"
    )
    enabled = Column(Boolean, nullable=False, default=False, server_default="0")
    # ok / hook_missing / error
    status = Column(String(32), nullable=False, default="", server_default="")
    last_error = Column(String(1000), nullable=False, default="", server_default="")
    last_reconcile_at = Column(
        DateTime,
        nullable=False,
        default=EPOCH_TIME,
        server_default="1970-01-01 00:00:00",
    )
    created_by_user_id = Column(
        big_integer_id_type(), nullable=False, default=0, server_default="0"
    )
    created_at = Column(DateTime, nullable=False, server_default=func.now())
    updated_at = Column(
        DateTime, nullable=False, server_default=func.now(), onupdate=func.now()
    )

    __table_args__ = (
        # A project owns at most one MR integration (one repo per project).
        UniqueConstraint("cloud_project_id", name="uniq_mr_integrations_project"),
        UniqueConstraint("webhook_token", name="uniq_mr_integrations_webhook_token"),
        Index("idx_mr_integrations_enabled", "enabled"),
        {"mysql_engine": "InnoDB", "mysql_charset": "utf8mb4"},
    )


class MRRecord(Base):
    """Per-MR state across webhook events; rounds accumulate by head SHA."""

    __tablename__ = "mr_records"

    id = Column(big_integer_id_type(), primary_key=True, autoincrement=True)
    integration_id = Column(
        big_integer_id_type(), nullable=False, default=0, server_default="0"
    )
    mr_iid = Column(
        big_integer_id_type(), nullable=False, default=0, server_default="0"
    )
    project_key = Column(String(16), nullable=False, default="", server_default="")
    source_branch = Column(String(255), nullable=False, default="", server_default="")
    target_branch = Column(String(255), nullable=False, default="", server_default="")
    author_id = Column(
        big_integer_id_type(), nullable=False, default=0, server_default="0"
    )
    mr_title = Column(String(255), nullable=False, default="", server_default="")
    # evaluating / actionable / clean / closed
    state = Column(
        String(16), nullable=False, default="evaluating", server_default="evaluating"
    )
    head_sha = Column(String(64), nullable=False, default="", server_default="")
    round_number = Column(
        big_integer_id_type(), nullable=False, default=1, server_default="1"
    )
    pipeline_status = Column(
        String(24), nullable=False, default="pending", server_default="pending"
    )
    pipeline_id = Column(
        big_integer_id_type(), nullable=False, default=0, server_default="0"
    )
    current_loop_item_id = Column(
        String(64), nullable=False, default="", server_default=""
    )
    # How many times the state machine auto-re-triggered a run for the assigned
    # robot on new actionable feedback; capped by project ai_automation.
    auto_retrigger_count = Column(
        big_integer_id_type(), nullable=False, default=0, server_default="0"
    )
    # Note ids the most recent robot run saw when it dispatched. Comments outside
    # this set are pending feedback: they arrived after the run read the card, so
    # they must pull the card back for another run instead of being treated as
    # addressed by the fix.
    seen_note_ids = Column(
        JSON,
        nullable=False,
        default=list,
        comment="Note ids the last robot run saw at dispatch; others are pending",
    )
    snapshot_json = Column(JSON, nullable=False, default=dict)
    rounds_json = Column(JSON, nullable=False, default=list)
    version = Column(
        big_integer_id_type(), nullable=False, default=1, server_default="1"
    )
    created_at = Column(DateTime, nullable=False, server_default=func.now())
    updated_at = Column(
        DateTime, nullable=False, server_default=func.now(), onupdate=func.now()
    )
    closed_at = Column(
        DateTime,
        nullable=False,
        default=EPOCH_TIME,
        server_default="1970-01-01 00:00:00",
    )

    __table_args__ = (
        Index("idx_mr_records_reconcile", "integration_id", "state", "head_sha"),
        Index(
            "idx_mr_records_pipeline_lookup",
            "integration_id",
            "head_sha",
            "round_number",
        ),
        {"mysql_engine": "InnoDB", "mysql_charset": "utf8mb4"},
    )
