# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Factory for creating Kind services
"""
from typing import Dict, Type

from app.services.kind_base import KindBaseService
from app.services.kind_impl import (
    BotKindService,
    GhostKindService,
    KnowledgeBaseKindService,
    ModelKindService,
    RetrieverKindService,
    ShellKindService,
    TaskKindService,
    TeamKindService,
    WorkspaceKindService,
)


class KindServiceFactory:
    """Factory for creating Kind services"""

    _services: Dict[str, KindBaseService] = {}

    @classmethod
    def get_service(cls, kind: str) -> KindBaseService:
        """Get service for a specific kind"""
        if kind not in cls._services:
            cls._services[kind] = cls._create_service(kind)
        return cls._services[kind]

    @staticmethod
    def _create_service(kind: str) -> KindBaseService:
        """Create service for a specific kind"""
        if kind == "Ghost":
            return GhostKindService()
        elif kind == "Model":
            return ModelKindService()
        elif kind == "Shell":
            return ShellKindService()
        elif kind == "Bot":
            return BotKindService()
        elif kind == "Team":
            return TeamKindService()
        elif kind == "Workspace":
            return WorkspaceKindService()
        elif kind == "Task":
            return TaskKindService()
        elif kind == "KnowledgeBase":
            return KnowledgeBaseKindService()
        elif kind == "Retriever":
            return RetrieverKindService()
        else:
            raise ValueError(f"Unknown kind: {kind}")
