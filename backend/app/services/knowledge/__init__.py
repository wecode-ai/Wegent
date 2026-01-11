# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Knowledge base related services.

This module provides services for knowledge base and document management,
including summarization and QA history.
"""

from app.services.knowledge.knowledge_base_qa_service import (
    KnowledgeBaseQAService,
    knowledge_base_qa_service,
)
from app.services.knowledge.knowledge_service import KnowledgeService
from app.services.knowledge.summary_service import SummaryService, summary_service
from app.services.knowledge.task_knowledge_base_service import (
    BoundKnowledgeBaseDetail,
    TaskKnowledgeBaseService,
    task_knowledge_base_service,
)

__all__ = [
    "KnowledgeService",
    "TaskKnowledgeBaseService",
    "task_knowledge_base_service",
    "BoundKnowledgeBaseDetail",
    "KnowledgeBaseQAService",
    "knowledge_base_qa_service",
    "SummaryService",
    "summary_service",
]
