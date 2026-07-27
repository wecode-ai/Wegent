# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Metric table model registry."""

from knowledge_engine.stat.models.metrics.collaboration import (
    ApprovalEfficiency,
    CrossOrgAccess,
    InvitationChain,
    KbMemberScale,
    PermissionChangeTrend,
    ShareLinkUsage,
)
from knowledge_engine.stat.models.metrics.content_quality import (
    ContentFreshness,
    DocChunkQuality,
    DuplicateDocSuspect,
    KbContentFreshness,
    KbThinDocRate,
)
from knowledge_engine.stat.models.metrics.dashboard import (
    DailyDashboard,
    GlobalTotals,
    KbDailyStats,
    PeriodTotals,
)
from knowledge_engine.stat.models.metrics.deep_analysis import (
    DocLifecycleTrace,
    DocValueRanking,
    KbGrowthCurve,
    KbHealthScore,
    KnowledgeCoverage,
    RagHeadVerifyRate,
    UserPatternEvolution,
    UserSegmentation,
)
from knowledge_engine.stat.models.metrics.doc_management import KbAvgDocLength
from knowledge_engine.stat.models.metrics.lifecycle import (
    KbActivity,
    KbConfigSanity,
    KbCreationTrend,
)
from knowledge_engine.stat.models.metrics.prometheus import (
    PromActiveConversions,
    PromCallbackSuccessRate,
    PromConversionDuration,
    PromConversionSuccessRate,
)
from knowledge_engine.stat.models.metrics.retrieval import (
    AnswerAdoptionRate,
    ChunksCountDistribution,
    DocReadCount,
    DocReferenceCount,
    KbActiveUsers,
    KbHeadFrequency,
    KbLowScoreRate,
    KbRagHeadRatio,
    KbRetrievalHitRate,
    KbRetrievalModeDist,
    KbSlowQueryRate,
    KbZeroChunkRate,
    QueryDedupRate,
    RagCallFrequency,
    RagCallLimit,
    RagVsHeadRatio,
    RestrictedModeUsage,
    RetrievalModeDistribution,
    RetrievalScoreDistribution,
    SelectedDocumentsUsage,
)
from knowledge_engine.stat.models.metrics.sys_ops import (
    AttachmentStorage,
    DocIndexStorageView,
    StorageUsage,
)
from knowledge_engine.stat.models.metrics.user_behavior import (
    CrossKbQueryUser,
    DocUploaderRanking,
    KbCreatorRanking,
    RestrictedAnalystUsage,
    RetrievalActiveUser,
    UserFirstKbUsage,
    UserKbBinding,
    UserParticipationSummary,
    UserPermissionDistribution,
    UserRagHeadPreference,
)

__all__ = [
    # dashboard
    "GlobalTotals",
    "PeriodTotals",
    "DailyDashboard",
    "KbDailyStats",
    # lifecycle
    "KbCreationTrend",
    "KbActivity",
    "KbConfigSanity",
    # retrieval
    "RagCallFrequency",
    "KbHeadFrequency",
    "RagVsHeadRatio",
    "DocReferenceCount",
    "DocReadCount",
    "RetrievalModeDistribution",
    "RestrictedModeUsage",
    "RagCallLimit",
    "SelectedDocumentsUsage",
    "ChunksCountDistribution",
    "KbActiveUsers",
    "KbRagHeadRatio",
    "KbZeroChunkRate",
    "KbRetrievalModeDist",
    "RetrievalScoreDistribution",
    "KbLowScoreRate",
    "AnswerAdoptionRate",
    "KbRetrievalHitRate",
    "QueryDedupRate",
    "KbSlowQueryRate",
    # user_behavior
    "KbCreatorRanking",
    "DocUploaderRanking",
    "RetrievalActiveUser",
    "UserRagHeadPreference",
    "UserKbBinding",
    "UserPermissionDistribution",
    "RestrictedAnalystUsage",
    "UserFirstKbUsage",
    "UserParticipationSummary",
    "CrossKbQueryUser",
    # collaboration
    "KbMemberScale",
    "InvitationChain",
    "ShareLinkUsage",
    "ApprovalEfficiency",
    "CrossOrgAccess",
    "PermissionChangeTrend",
    # sys_ops
    "StorageUsage",
    "AttachmentStorage",
    "DocIndexStorageView",
    # deep_analysis
    "KbHealthScore",
    "DocValueRanking",
    "DocLifecycleTrace",
    "UserPatternEvolution",
    "KbGrowthCurve",
    "RagHeadVerifyRate",
    "KnowledgeCoverage",
    "UserSegmentation",
    # prometheus
    "PromConversionSuccessRate",
    "PromConversionDuration",
    "PromActiveConversions",
    "PromCallbackSuccessRate",
    # content_quality
    "KbThinDocRate",
    "DocChunkQuality",
    "ContentFreshness",
    "KbContentFreshness",
    "DuplicateDocSuspect",
    # doc_management (P3 addition)
    "KbAvgDocLength",
]
