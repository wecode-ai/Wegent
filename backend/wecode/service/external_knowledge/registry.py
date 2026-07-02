# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""In-process registry for external knowledge browse providers."""

from wecode.service.external_knowledge.base import ExternalKnowledgeProvider
from wecode.service.external_knowledge.exceptions import ExternalKnowledgeError

_providers: dict[str, ExternalKnowledgeProvider] = {}


def register(provider: ExternalKnowledgeProvider) -> None:
    """Register or replace a browse provider."""
    _providers[provider.name] = provider


def get(provider_name: str) -> ExternalKnowledgeProvider:
    """Return a registered provider or raise a stable API error."""
    provider = _providers.get(provider_name)
    if provider is None:
        raise ExternalKnowledgeError(
            f"Unknown external knowledge provider: {provider_name}",
            code="provider_not_found",
            status_code=404,
        )
    return provider


def clear() -> None:
    """Clear providers for tests."""
    _providers.clear()
