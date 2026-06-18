# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Registry for external knowledge providers."""

import importlib
import logging
from typing import Any

from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.user import User
from app.schemas.kind import DefaultContextRef
from app.services.external_knowledge.base import (
    ExternalKnowledgeProvider,
    ResolvedExternalKnowledge,
)

logger = logging.getLogger(__name__)


class ExternalKnowledgeProviderRegistry:
    """Resolve external knowledge through registered providers."""

    def __init__(self, providers: list[ExternalKnowledgeProvider] | None = None):
        self._providers = providers or []

    def resolve(
        self,
        db: Session,
        user: User,
        ref: DefaultContextRef,
        bound_at: str,
    ) -> ResolvedExternalKnowledge:
        for provider in self._providers:
            if provider.supports(ref):
                return provider.resolve(db, user, ref, bound_at)
        return ResolvedExternalKnowledge(
            warning={
                "type": "external_document",
                "reason": "provider_unsupported",
                "message": "该外部知识类型暂不支持, 无法读取",
                "name": getattr(ref, "name", ""),
                "provider": getattr(ref, "type", ""),
            }
        )

    def context_item_to_default_ref(
        self, raw: dict[str, Any]
    ) -> DefaultContextRef | None:
        for provider in self._providers:
            ref = provider.context_item_to_default_ref(raw)
            if ref is not None:
                return ref
        return None


def build_default_external_knowledge_registry() -> ExternalKnowledgeProviderRegistry:
    """Build the default external knowledge registry.

    Providers are loaded from import paths so chat initialization depends on the
    extension point instead of individual external systems.
    """
    providers: list[ExternalKnowledgeProvider] = []
    for import_path in settings.EXTERNAL_KNOWLEDGE_PROVIDER_IMPORTS:
        provider = _load_provider(import_path)
        if provider is not None:
            providers.append(provider)
    return ExternalKnowledgeProviderRegistry(providers=providers)


def _load_provider(import_path: str) -> ExternalKnowledgeProvider | None:
    module_path, separator, attr_name = import_path.partition(":")
    if not module_path or separator != ":" or not attr_name:
        logger.warning(
            "Invalid external knowledge provider import path: %s", import_path
        )
        return None

    try:
        module = importlib.import_module(module_path)
        provider_cls = getattr(module, attr_name)
        return provider_cls()
    except (AttributeError, ImportError, TypeError) as exc:
        logger.warning(
            "Failed to load external knowledge provider %s: %s",
            import_path,
            exc,
        )
        return None
