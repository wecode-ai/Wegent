# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""User behavior metric tables."""

from sqlalchemy import BigInteger, Column, Date, DateTime, Float, Index, Integer, String
from sqlalchemy.sql import func

from knowledge_engine.stat.models.base import StatBase


class KbCreatorRanking(StatBase):
    """KB creator ranking by user (cross-section)."""

    __tablename__ = "kb_stat_kb_creator_ranking"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    run_id = Column(BigInteger, nullable=False)
    target_date = Column(Date, nullable=False)
    user_id = Column(BigInteger)
    user_name = Column(String(255))
    kb_count = Column(Integer, default=0)
    created_at = Column(DateTime, default=func.now())

    __table_args__ = (
        Index("idx_kb_creator_ranking_run", "run_id"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )


class DocUploaderRanking(StatBase):
    """Document uploader ranking by user (cross-section)."""

    __tablename__ = "kb_stat_doc_uploader_ranking"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    run_id = Column(BigInteger, nullable=False)
    target_date = Column(Date, nullable=False)
    user_id = Column(BigInteger)
    user_name = Column(String(255))
    upload_count = Column(Integer, default=0)
    created_at = Column(DateTime, default=func.now())

    __table_args__ = (
        Index("idx_doc_uploader_ranking_run", "run_id"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )


class RetrievalActiveUser(StatBase):
    """Retrieval active user with head/RAG breakdown (cross-section)."""

    __tablename__ = "kb_stat_retrieval_active_user"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    run_id = Column(BigInteger, nullable=False)
    target_date = Column(Date, nullable=False)
    user_id = Column(BigInteger)
    user_name = Column(String(255))
    rag_count = Column(Integer, default=0)
    head_count = Column(Integer, default=0)
    total_count = Column(Integer, default=0)
    user_tier = Column(String(32))
    created_at = Column(DateTime, default=func.now())

    __table_args__ = (
        Index("idx_retrieval_active_user_run", "run_id"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )


class UserRagHeadPreference(StatBase):
    """Per-user RAG vs head retrieval preference (cross-section)."""

    __tablename__ = "kb_stat_user_rag_head_preference"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    run_id = Column(BigInteger, nullable=False)
    target_date = Column(Date, nullable=False)
    user_id = Column(BigInteger)
    user_name = Column(String(255))
    rag_count = Column(Integer, default=0)
    head_count = Column(Integer, default=0)
    preference = Column(String(32))
    created_at = Column(DateTime, default=func.now())

    __table_args__ = (
        Index("idx_user_rag_head_pref_run", "run_id"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )


class UserKbBinding(StatBase):
    """Per-user KB binding with task count (cross-section)."""

    __tablename__ = "kb_stat_user_kb_binding"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    run_id = Column(BigInteger, nullable=False)
    target_date = Column(Date, nullable=False)
    kb_id = Column(BigInteger)
    kb_name = Column(String(255))
    task_count = Column(Integer, default=0)
    created_at = Column(DateTime, default=func.now())

    __table_args__ = (
        Index("idx_user_kb_binding_run", "run_id"),
        Index("idx_user_kb_binding_kb", "kb_id"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )


class UserPermissionDistribution(StatBase):
    """User permission role distribution (cross-section)."""

    __tablename__ = "kb_stat_user_permission_distribution"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    run_id = Column(BigInteger, nullable=False)
    target_date = Column(Date, nullable=False)
    role = Column(String(64))
    user_count = Column(Integer, default=0)
    created_at = Column(DateTime, default=func.now())

    __table_args__ = (
        Index("idx_user_perm_dist_run", "run_id"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )


class RestrictedAnalystUsage(StatBase):
    """Restricted analyst usage per KB (cross-section)."""

    __tablename__ = "kb_stat_restricted_analyst_usage"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    run_id = Column(BigInteger, nullable=False)
    target_date = Column(Date, nullable=False)
    kb_id = Column(BigInteger)
    analyst_count = Column(Integer, default=0)
    created_at = Column(DateTime, default=func.now())

    __table_args__ = (
        Index("idx_restricted_analyst_run", "run_id"),
        Index("idx_restricted_analyst_kb", "kb_id"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )


class UserFirstKbUsage(StatBase):
    """User first KB usage timing from registration (cross-section)."""

    __tablename__ = "kb_stat_user_first_kb_usage"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    run_id = Column(BigInteger, nullable=False)
    target_date = Column(Date, nullable=False)
    user_id = Column(BigInteger)
    user_name = Column(String(255))
    registered_at = Column(DateTime, nullable=True)
    first_kb_usage_at = Column(DateTime, nullable=True)
    days_to_first = Column(Float, nullable=True)
    created_at = Column(DateTime, default=func.now())

    __table_args__ = (
        Index("idx_user_first_kb_usage_run", "run_id"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )


class UserParticipationSummary(StatBase):
    """User participation role summary (cross-section)."""

    __tablename__ = "kb_stat_user_participation_summary"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    run_id = Column(BigInteger, nullable=False)
    target_date = Column(Date, nullable=False)
    user_id = Column(BigInteger)
    user_name = Column(String(255))
    is_creator = Column(Integer, default=0)
    is_uploader = Column(Integer, default=0)
    is_retriever = Column(Integer, default=0)
    is_member = Column(Integer, default=0)
    participation_type = Column(String(64))
    created_at = Column(DateTime, default=func.now())

    __table_args__ = (
        Index("idx_user_participation_run", "run_id"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )


class CrossKbQueryUser(StatBase):
    """Users who queried multiple KBs (signal for KB topology issues)."""

    __tablename__ = "kb_stat_cross_kb_query_user"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    run_id = Column(BigInteger, nullable=False)
    target_date = Column(Date, nullable=False)
    user_id = Column(BigInteger, nullable=False)
    user_name = Column(String(255), nullable=True)
    kb_count = Column(Integer, nullable=False, default=0)
    query_count = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime, nullable=False, default=func.now())

    __table_args__ = (
        Index("idx_cross_kb_query_user_run", "run_id"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )
