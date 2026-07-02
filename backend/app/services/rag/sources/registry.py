"""Registry for external retrieval source providers."""

from __future__ import annotations

from collections.abc import Iterable

from .models import RetrievalSourceProvider


class RetrievalSourceRegistry:
    """In-process registry for external retrieval providers."""

    def __init__(self) -> None:
        self._providers: dict[str, RetrievalSourceProvider] = {}

    def register(self, provider: RetrievalSourceProvider) -> None:
        """Register or replace a provider by name."""
        self._providers[provider.name] = provider

    def get(self, name: str) -> RetrievalSourceProvider | None:
        """Return a provider by name."""
        return self._providers.get(name)

    def iter(self) -> Iterable[RetrievalSourceProvider]:
        """Iterate registered providers."""
        return self._providers.values()


retrieval_source_registry = RetrievalSourceRegistry()
