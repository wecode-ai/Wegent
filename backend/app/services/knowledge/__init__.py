# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Knowledge-related services package.

This module intentionally resolves exports lazily to avoid circular imports
between schemas, service helpers, and the package-level convenience imports.
"""

from __future__ import annotations

from importlib import import_module

_EXPORT_MAP = {
    "KnowledgeBaseQAService": (
        "app.services.knowledge.knowledge_base_qa_service",
        "KnowledgeBaseQAService",
    ),
    "knowledge_base_qa_service": (
        "app.services.knowledge.knowledge_base_qa_service",
        "knowledge_base_qa_service",
    ),
    "KnowledgeService": (
        "app.services.knowledge.knowledge_service",
        "KnowledgeService",
    ),
    "KnowledgeOrchestrator": (
        "app.services.knowledge.orchestrator",
        "KnowledgeOrchestrator",
    ),
    "knowledge_orchestrator": (
        "app.services.knowledge.orchestrator",
        "knowledge_orchestrator",
    ),
    "can_create_namespace_knowledge_base": (
        "app.services.knowledge.permission_policy",
        "can_create_namespace_knowledge_base",
    ),
    "can_manage_namespace": (
        "app.services.knowledge.permission_policy",
        "can_manage_namespace",
    ),
    "can_manage_namespace_knowledge_base": (
        "app.services.knowledge.permission_policy",
        "can_manage_namespace_knowledge_base",
    ),
    "SummaryService": ("app.services.knowledge.summary_service", "SummaryService"),
    "get_summary_service": (
        "app.services.knowledge.summary_service",
        "get_summary_service",
    ),
    "TaskKnowledgeBaseService": (
        "app.services.knowledge.task_knowledge_base_service",
        "TaskKnowledgeBaseService",
    ),
}


def __getattr__(name: str):
    if name not in _EXPORT_MAP:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")

    module_name, attribute_name = _EXPORT_MAP[name]
    value = getattr(import_module(module_name), attribute_name)
    globals()[name] = value
    return value


__all__ = list(_EXPORT_MAP)
