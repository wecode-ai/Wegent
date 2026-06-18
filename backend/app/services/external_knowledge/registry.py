# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Registry for external knowledge providers."""

import importlib
import logging
from typing import Any, Callable

from fastapi import HTTPException
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
            supports = _get_callable(provider, "supports")
            resolve = _get_callable(provider, "resolve")
            if supports is not None and resolve is not None and supports(ref):
                return resolve(db, user, ref, bound_at)
        return ResolvedExternalKnowledge(
            warning={
                "type": "external_document",
                "reason": "provider_unsupported",
                "message": "该外部知识类型暂不支持, 无法读取",
                "name": getattr(ref, "name", ""),
                "provider": getattr(ref, "provider", getattr(ref, "type", "")),
                "source": getattr(ref, "source", ""),
                "external_id": getattr(ref, "id", ""),
            }
        )

    def context_item_to_default_ref(
        self, raw: dict[str, Any]
    ) -> DefaultContextRef | None:
        for provider in self._providers:
            parser = _get_callable(provider, "context_item_to_default_ref")
            if parser is None:
                continue
            ref = parser(raw)
            if ref is not None:
                return ref
        return None

    def validate_ref(
        self,
        db: Session,
        user: User,
        ref: DefaultContextRef,
        namespace: str,
    ) -> None:
        for provider in self._providers:
            supports = _get_callable(provider, "supports")
            validate = _get_callable(provider, "validate_ref")
            if supports is not None and validate is not None and supports(ref):
                validate(db, user, ref, namespace)
                return
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported external knowledge type: {ref.type}",
        )

    def get_runtime_skill_names(self, context: dict[str, Any]) -> list[str]:
        for provider in self._providers:
            supports = _get_callable(provider, "supports_task_context")
            get_skill_names = _get_callable(provider, "get_runtime_skill_names")
            if (
                supports is not None
                and get_skill_names is not None
                and supports(context)
            ):
                return get_skill_names(context)
        return []

    def build_runtime_guidance(self, contexts: list[dict[str, Any]]) -> str | None:
        sections: list[str] = []
        for provider in self._providers:
            supports = _get_callable(provider, "supports_task_context")
            build_guidance = _get_callable(provider, "build_runtime_guidance")
            if supports is None or build_guidance is None:
                continue
            provider_contexts = [context for context in contexts if supports(context)]
            if not provider_contexts:
                continue
            guidance = build_guidance(provider_contexts)
            if guidance:
                sections.append(guidance)
        if not sections:
            return None
        return "\n\n".join(sections)


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


def _get_callable(
    provider: ExternalKnowledgeProvider, name: str
) -> Callable[..., Any] | None:
    value = getattr(provider, name, None)
    return value if callable(value) else None
