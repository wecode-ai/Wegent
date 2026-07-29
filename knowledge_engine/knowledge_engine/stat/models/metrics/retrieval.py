# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Retrieval metric tables."""

from sqlalchemy import BigInteger, Column, Date, DateTime, Float, Index, Integer, String
from sqlalchemy.sql import func

from knowledge_engine.stat.models.base import StatBase


class RagCallFrequency(StatBase):
    """Daily RAG call frequency per KB."""

    __tablename__ = "kb_stat_rag_call_frequency"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    run_id = Column(BigInteger, nullable=False)
    target_date = Column(Date, nullable=False)
    stat_date = Column(Date, nullable=False)
    kb_id = Column(BigInteger, nullable=False)
    kb_name = Column(String(255), nullable=True)
    call_count = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime, nullable=False, default=func.now())

    __table_args__ = (
        Index("idx_rag_call_freq_run", "run_id"),
        Index("idx_rag_call_freq_date", "stat_date"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )


class KbHeadFrequency(StatBase):
    """Daily KB head RAG call frequency per KB."""

    __tablename__ = "kb_stat_kb_head_frequency"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    run_id = Column(BigInteger, nullable=False)
    target_date = Column(Date, nullable=False)
    stat_date = Column(Date, nullable=False)
    kb_id = Column(BigInteger, nullable=False)
    kb_name = Column(String(255), nullable=True)
    call_count = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime, nullable=False, default=func.now())

    __table_args__ = (
        Index("idx_kb_head_freq_run", "run_id"),
        Index("idx_kb_head_freq_date", "stat_date"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )


class RagVsHeadRatio(StatBase):
    """Daily RAG vs head injection ratio."""

    __tablename__ = "kb_stat_rag_vs_head_ratio"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    run_id = Column(BigInteger, nullable=False)
    target_date = Column(Date, nullable=False)
    stat_date = Column(Date, nullable=False)
    rag_count = Column(Integer, nullable=False, default=0)
    head_count = Column(Integer, nullable=False, default=0)
    rag_ratio = Column(Float, nullable=True)
    created_at = Column(DateTime, nullable=False, default=func.now())

    __table_args__ = (
        Index("idx_rag_vs_head_run", "run_id"),
        Index("idx_rag_vs_head_date", "stat_date"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )


class DocReferenceCount(StatBase):
    """Per-document reference count breakdown (RAG vs head)."""

    __tablename__ = "kb_stat_doc_reference_count"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    run_id = Column(BigInteger, nullable=False)
    target_date = Column(Date, nullable=False)
    document_id = Column(BigInteger, nullable=False)
    document_name = Column(String(255), nullable=True)
    kb_id = Column(BigInteger, nullable=False)
    rag_ref_count = Column(Integer, nullable=False, default=0)
    head_ref_count = Column(Integer, nullable=False, default=0)
    total_ref_count = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime, nullable=False, default=func.now())

    __table_args__ = (
        Index("idx_doc_ref_run", "run_id"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )


class DocReadCount(StatBase):
    """Per-document read count."""

    __tablename__ = "kb_stat_doc_read_count"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    run_id = Column(BigInteger, nullable=False)
    target_date = Column(Date, nullable=False)
    document_id = Column(BigInteger, nullable=False)
    document_name = Column(String(255), nullable=True)
    kb_id = Column(BigInteger, nullable=False)
    read_count = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime, nullable=False, default=func.now())

    __table_args__ = (
        Index("idx_doc_read_run", "run_id"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )


class RetrievalModeDistribution(StatBase):
    """Retrieval injection mode distribution (cross-section)."""

    __tablename__ = "kb_stat_retrieval_mode_distribution"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    run_id = Column(BigInteger, nullable=False)
    target_date = Column(Date, nullable=False)
    injection_mode = Column(String(64), nullable=True)
    call_count = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime, nullable=False, default=func.now())

    __table_args__ = (
        Index("idx_retrieval_mode_run", "run_id"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )


class RestrictedModeUsage(StatBase):
    """Per-KB restricted mode usage statistics (cross-section)."""

    __tablename__ = "kb_stat_restricted_mode_usage"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    run_id = Column(BigInteger, nullable=False)
    target_date = Column(Date, nullable=False)
    kb_id = Column(BigInteger, nullable=False)
    total_calls = Column(Integer, nullable=False, default=0)
    restricted_calls = Column(Integer, nullable=False, default=0)
    restricted_rate = Column(Float, nullable=True)
    created_at = Column(DateTime, nullable=False, default=func.now())

    __table_args__ = (
        Index("idx_restricted_usage_run", "run_id"),
        Index("idx_restricted_usage_kb", "kb_id"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )


class RagCallLimit(StatBase):
    """Per-KB RAG call limit hit statistics (cross-section)."""

    __tablename__ = "kb_stat_rag_call_limit"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    run_id = Column(BigInteger, nullable=False)
    target_date = Column(Date, nullable=False)
    kb_id = Column(BigInteger, nullable=False)
    max_calls_config = Column(Integer, nullable=True)
    hit_limit_count = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime, nullable=False, default=func.now())

    __table_args__ = (
        Index("idx_rag_call_limit_run", "run_id"),
        Index("idx_rag_call_limit_kb", "kb_id"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )


class SelectedDocumentsUsage(StatBase):
    """Per-KB per-document selected usage count (cross-section)."""

    __tablename__ = "kb_stat_selected_documents_usage"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    run_id = Column(BigInteger, nullable=False)
    target_date = Column(Date, nullable=False)
    kb_id = Column(BigInteger, nullable=False)
    document_id = Column(BigInteger, nullable=False)
    select_count = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime, nullable=False, default=func.now())

    __table_args__ = (
        Index("idx_selected_docs_run", "run_id"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )


class ChunksCountDistribution(StatBase):
    """Returned chunks count distribution buckets (cross-section)."""

    __tablename__ = "kb_stat_chunks_count_distribution"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    run_id = Column(BigInteger, nullable=False)
    target_date = Column(Date, nullable=False)
    chunk_bucket = Column(String(32), nullable=True)
    call_count = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime, nullable=False, default=func.now())

    __table_args__ = (
        Index("idx_chunks_dist_run", "run_id"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )


class KbActiveUsers(StatBase):
    """Per-KB active users with RAG/head call counts (cross-section)."""

    __tablename__ = "kb_stat_kb_active_users"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    run_id = Column(BigInteger, nullable=False)
    target_date = Column(Date, nullable=False)
    kb_id = Column(BigInteger, nullable=False)
    user_id = Column(BigInteger, nullable=False)
    user_name = Column(String(255), nullable=True)
    rag_count = Column(Integer, nullable=False, default=0)
    head_count = Column(Integer, nullable=False, default=0)
    total_count = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime, nullable=False, default=func.now())

    __table_args__ = (
        Index("idx_kb_active_users_run", "run_id"),
        Index("idx_kb_active_users_kb", "kb_id"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )


class KbRagHeadRatio(StatBase):
    """Per-KB daily RAG vs head injection ratio."""

    __tablename__ = "kb_stat_kb_rag_head_ratio"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    run_id = Column(BigInteger, nullable=False)
    target_date = Column(Date, nullable=False)
    stat_date = Column(Date, nullable=False)
    kb_id = Column(BigInteger, nullable=False)
    rag_count = Column(Integer, nullable=False, default=0)
    head_count = Column(Integer, nullable=False, default=0)
    rag_ratio = Column(Float, nullable=True)
    created_at = Column(DateTime, nullable=False, default=func.now())

    __table_args__ = (
        Index("idx_kb_rag_head_ratio_run", "run_id"),
        Index("idx_kb_rag_head_ratio_date", "stat_date"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )


class KbZeroChunkRate(StatBase):
    """Per-KB daily zero-chunk query rate."""

    __tablename__ = "kb_stat_kb_zero_chunk_rate"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    run_id = Column(BigInteger, nullable=False)
    target_date = Column(Date, nullable=False)
    stat_date = Column(Date, nullable=False)
    kb_id = Column(BigInteger, nullable=False)
    total_queries = Column(Integer, nullable=False, default=0)
    zero_chunk_queries = Column(Integer, nullable=False, default=0)
    zero_chunk_rate = Column(Float, nullable=True)
    low_confidence = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime, nullable=False, default=func.now())

    __table_args__ = (
        Index("idx_kb_zero_chunk_run", "run_id"),
        Index("idx_kb_zero_chunk_kb", "kb_id"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )


class KbRetrievalModeDist(StatBase):
    """Per-KB retrieval injection mode distribution (cross-section)."""

    __tablename__ = "kb_stat_kb_retrieval_mode_dist"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    run_id = Column(BigInteger, nullable=False)
    target_date = Column(Date, nullable=False)
    kb_id = Column(BigInteger, nullable=False)
    injection_mode = Column(String(64), nullable=True)
    call_count = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime, nullable=False, default=func.now())

    __table_args__ = (
        Index("idx_kb_ret_mode_run", "run_id"),
        Index("idx_kb_ret_mode_kb", "kb_id"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )


class AnswerAdoptionRate(StatBase):
    """Per-KB daily answer adoption rate."""

    __tablename__ = "kb_stat_answer_adoption_rate"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    run_id = Column(BigInteger, nullable=False)
    target_date = Column(Date, nullable=False)
    stat_date = Column(Date, nullable=False)
    kb_id = Column(BigInteger, nullable=False)
    total_queries = Column(Integer, nullable=False, default=0)
    adopted_queries = Column(Integer, nullable=False, default=0)
    adoption_rate = Column(Float, nullable=True)
    low_confidence = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime, nullable=False, default=func.now())

    __table_args__ = (
        Index("idx_answer_adoption_run", "run_id"),
        Index("idx_answer_adoption_kb", "kb_id"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )


class KbRetrievalHitRate(StatBase):
    """Per-KB daily retrieval hit rate."""

    __tablename__ = "kb_stat_kb_retrieval_hit_rate"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    run_id = Column(BigInteger, nullable=False)
    target_date = Column(Date, nullable=False)
    stat_date = Column(Date, nullable=False)
    kb_id = Column(BigInteger, nullable=False)
    total_queries = Column(Integer, nullable=False, default=0)
    hit_queries = Column(Integer, nullable=False, default=0)
    hit_rate = Column(Float, nullable=True)  # 0-100 percentage
    low_confidence = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime, nullable=False, default=func.now())

    __table_args__ = (
        Index("idx_kb_hit_rate_run", "run_id"),
        Index("idx_kb_hit_rate_kb", "kb_id"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )
