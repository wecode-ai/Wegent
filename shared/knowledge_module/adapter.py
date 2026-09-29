# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Adapter boundary for the reusable knowledge module.

Adapters on each side (Wegent, internal edition) supply only records they have
already authorized: retrieved resource candidates, the stored system profile,
and the resolved resources for that profile. The module owns the composition and
validation rules; it never queries a product table itself.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping, Protocol, runtime_checkable

# CRD kinds the module recognizes. A retriever slot must be filled by a
# "Retriever"; an embedding slot must be filled by a "Model" whose resolved
# category is "embedding". The module compares these values, it does not resolve
# them, so it stays independent from each side's model catalog.
RETRIEVER_RESOURCE_KIND = "Retriever"
MODEL_RESOURCE_KIND = "Model"
EMBEDDING_RESOURCE_CATEGORY = "embedding"


@dataclass(frozen=True)
class RetrievalResource:
    """An authorized retrieval resource record supplied by an adapter.

    ``kind`` is the CRD kind. For models, ``category`` carries the resolved
    catalog category (for example ``"embedding"``) so the module can verify that
    the record matches the slot it is used for.
    """

    name: str
    kind: str
    namespace: str = "default"
    category: str | None = None


@dataclass(frozen=True)
class RetrievalProfileRecord:
    """The stored system profile as seen by a local adapter.

    ``configured`` is the stored retrieval configuration (or ``None`` when no
    profile is stored). ``retriever`` and ``embedding_model`` are the locally
    resolved, authorized records for the references that configuration names;
    ``None`` means the local service could not resolve an authorized resource,
    which makes the profile unusable.
    """

    configured: Mapping[str, Any] | None = None
    retriever: RetrievalResource | None = None
    embedding_model: RetrievalResource | None = None


@runtime_checkable
class KnowledgeConfigAdapter(Protocol):
    """Supplies authorized candidates and records to the knowledge module."""

    def retrieval_profile(self) -> RetrievalProfileRecord:
        """Return the stored system profile record the local service authorizes."""

    def default_retriever(self, namespace: str) -> RetrievalResource | None:
        """Return the authorized default Retriever for a namespace, if any."""

    def default_embedding_model(self, namespace: str) -> RetrievalResource | None:
        """Return the authorized default embedding Model for a namespace."""
