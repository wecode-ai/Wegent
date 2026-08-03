# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Collaboration metric tables (member scale, invitations, sharing, approvals)."""

from sqlalchemy import BigInteger, Column, Date, DateTime, Float, Index, Integer, String
from sqlalchemy.sql import func

from knowledge_engine.stat.models.base import StatBase


class KbMemberScale(StatBase):
    """KB member count distribution by scale bucket (cross-section)."""

    __tablename__ = "kb_stat_kb_member_scale"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    run_id = Column(BigInteger, nullable=False)
    target_date = Column(Date, nullable=False)
    scale_bucket = Column(String(32), nullable=True)
    kb_count = Column(Integer, default=0)
    created_at = Column(DateTime, default=func.now())

    __table_args__ = (
        Index("idx_member_scale_run", "run_id"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )


class InvitationChain(StatBase):
    """Invitation chain records linking inviter to invitee per KB."""

    __tablename__ = "kb_stat_invitation_chain"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    run_id = Column(BigInteger, nullable=False)
    target_date = Column(Date, nullable=False)
    inviter_id = Column(BigInteger, nullable=True)
    inviter_name = Column(String(255), nullable=True)
    invitee_id = Column(BigInteger, nullable=True)
    invitee_name = Column(String(255), nullable=True)
    role = Column(String(64), nullable=True)
    kb_id = Column(BigInteger, nullable=True)
    created_at = Column(DateTime, default=func.now())

    __table_args__ = (
        Index("idx_invitation_chain_run", "run_id"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )


class ShareLinkUsage(StatBase):
    """Share link usage statistics per KB (cross-section)."""

    __tablename__ = "kb_stat_share_link_usage"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    run_id = Column(BigInteger, nullable=False)
    target_date = Column(Date, nullable=False)
    kb_id = Column(BigInteger, nullable=True)
    kb_name = Column(String(255), nullable=True)
    link_count = Column(Integer, default=0)
    total_joins = Column(Integer, default=0)
    avg_joins_per_link = Column(Float, nullable=True)
    created_at = Column(DateTime, default=func.now())

    __table_args__ = (
        Index("idx_share_link_run", "run_id"),
        Index("idx_share_link_kb", "kb_id"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )


class ApprovalEfficiency(StatBase):
    """Approval efficiency metrics per KB (cross-section)."""

    __tablename__ = "kb_stat_approval_efficiency"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    run_id = Column(BigInteger, nullable=False)
    target_date = Column(Date, nullable=False)
    kb_id = Column(BigInteger, nullable=True)
    avg_approval_minutes = Column(Float, nullable=True)
    total_requests = Column(Integer, default=0)
    approved_count = Column(Integer, default=0)
    approval_rate = Column(Float, nullable=True)
    created_at = Column(DateTime, default=func.now())

    __table_args__ = (
        Index("idx_approval_eff_run", "run_id"),
        Index("idx_approval_eff_kb", "kb_id"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )


class CrossOrgAccess(StatBase):
    """Cross-organization access records per KB per user (cross-section)."""

    __tablename__ = "kb_stat_cross_org_access"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    run_id = Column(BigInteger, nullable=False)
    target_date = Column(Date, nullable=False)
    kb_id = Column(BigInteger, nullable=True)
    kb_namespace = Column(String(128), nullable=True)
    kb_name = Column(String(255), nullable=True)
    user_id = Column(BigInteger, nullable=True)
    user_namespace = Column(String(128), nullable=True)
    role = Column(String(64), nullable=True)
    created_at = Column(DateTime, default=func.now())

    __table_args__ = (
        Index("idx_cross_org_run", "run_id"),
        Index("idx_cross_org_kb", "kb_id"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )


class PermissionChangeTrend(StatBase):
    """Permission change counts by role and status over time."""

    __tablename__ = "kb_stat_permission_change_trend"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    run_id = Column(BigInteger, nullable=False)
    target_date = Column(Date, nullable=False)
    stat_date = Column(Date, nullable=True)
    role = Column(String(64), nullable=True)
    status = Column(String(64), nullable=True)
    change_count = Column(Integer, default=0)
    created_at = Column(DateTime, default=func.now())

    __table_args__ = (
        Index("idx_perm_change_run", "run_id"),
        Index("idx_perm_change_date", "stat_date"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )
