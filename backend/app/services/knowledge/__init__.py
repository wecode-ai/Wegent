# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Knowledge-related services package.

This module provides services for:
- Knowledge base CRUD operations
- Document summary generation
- Knowledge base summary generation
- RAG (Retrieval-Augmented Generation) integration
- Task-knowledge base relationship management
"""

from app.services.knowledge.knowledge_base_qa_service import (
    KnowledgeBaseQAService,
    knowledge_base_qa_service,
)
from app.services.knowledge.knowledge_service import KnowledgeService
from app.services.knowledge.summary_service import SummaryService, get_summary_service
from app.services.knowledge.task_knowledge_base_service import TaskKnowledgeBaseService

__all__ = [
    "KnowledgeService",
    "SummaryService",
    "get_summary_service",
    "KnowledgeBaseQAService",
    "knowledge_base_qa_service",
    "TaskKnowledgeBaseService",
]
