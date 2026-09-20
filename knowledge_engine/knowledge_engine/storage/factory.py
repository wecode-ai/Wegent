# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Storage backend factory for resolved runtime config."""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Type

from knowledge_engine.storage.base import BaseStorageBackend
from knowledge_engine.storage.elasticsearch_backend import ElasticsearchBackend
from knowledge_engine.storage.milvus.backend import MilvusBackend
from knowledge_engine.storage.milvus_backend import MilvusBackend as LegacyMilvusBackend
from knowledge_engine.storage.qdrant_backend import QdrantBackend
from shared.models import RuntimeRetrieverConfig

MILVUS_STORAGE_TYPE = "milvus"
# The prefix that routes ``milvus`` to the second generation while both
# adapters are in service. Only an exact match selects it: a knowledge base
# whose prefix is ``wegent_v20`` or ``my_wegent_v2`` keeps serving the
# collections the online main branch wrote. This is a temporary protocol with
# an exit condition - once the legacy adapter, its LlamaIndex dependency and
# this rule are deleted, ``milvus`` always builds the second generation and the
# prefix goes back to being a plain collection naming parameter.
MILVUS_V2_RESERVED_PREFIX = "wegent_v2"
MILVUS_V2_INDEX_MODE = "per_dataset"


class UnsupportedStorageTypeError(ValueError):
    """A storage type no adapter in this factory answers."""


# The storage type a Retriever configures is public; which adapter answers it
# is ``resolve_storage_backend_class``'s decision. The ``milvus`` entry is the
# frozen snapshot of the adapter the online main branch shipped, which the
# import above aliases to say which generation it is. That file is kept
# byte-identical, so it is the one file the ticket holds out of the
# repository's file size rule.
STORAGE_BACKEND_REGISTRY: Dict[str, Type[BaseStorageBackend]] = {
    "elasticsearch": ElasticsearchBackend,
    "qdrant": QdrantBackend,
    MILVUS_STORAGE_TYPE: LegacyMilvusBackend,
}


def _normalize_storage_type(storage_type: Any) -> str:
    """Lower-case the configured type so it can be matched the way it always is."""
    return str(storage_type or "").lower()


def _unsupported_storage_type_error(storage_type: str) -> UnsupportedStorageTypeError:
    return UnsupportedStorageTypeError(
        f"Unsupported storage type: {storage_type or '<missing>'}. "
        f"Supported types: {list(STORAGE_BACKEND_REGISTRY.keys())}"
    )


def resolve_storage_backend_class(
    storage_type: str,
    index_strategy: Optional[Dict[str, Any]] = None,
) -> Type[BaseStorageBackend]:
    """The one rule that decides which adapter answers one storage config.

    ``milvus`` is the only type with two adapters, and one config selects the
    second generation: ``per_dataset`` with the reserved prefix, compared for
    equality. An absent prefix, the default ``wegent`` and any other value keep
    the frozen legacy adapter, so a knowledge base keeps reading and writing
    the collections the online main branch wrote. A reserved prefix on a
    strategy that shares one index between knowledge bases fails explicitly
    rather than falling back, because such a strategy names its physical
    collection from something other than that prefix. An unknown type keeps
    failing here too.

    The construction entries and the replacement-ownership query both resolve
    through this function, so the adapter a config is built from and the
    capability that config declares can never disagree.
    """
    normalized_type = _normalize_storage_type(storage_type)
    if normalized_type not in STORAGE_BACKEND_REGISTRY:
        raise _unsupported_storage_type_error(normalized_type)
    if normalized_type != MILVUS_STORAGE_TYPE:
        return STORAGE_BACKEND_REGISTRY[normalized_type]
    return _resolve_milvus_backend_class(index_strategy)


def _resolve_milvus_backend_class(
    index_strategy: Optional[Dict[str, Any]],
) -> Type[BaseStorageBackend]:
    """Route one ``milvus`` config to the adapter that owns its collection."""
    if not isinstance(index_strategy, dict):
        # A strategy this rule cannot read declares no reserved prefix, so it
        # names no collection of the second generation.
        return LegacyMilvusBackend
    if index_strategy.get("prefix") != MILVUS_V2_RESERVED_PREFIX:
        return LegacyMilvusBackend
    mode = index_strategy.get("mode", MILVUS_V2_INDEX_MODE)
    if mode != MILVUS_V2_INDEX_MODE:
        raise ValueError(
            f"index strategy prefix {MILVUS_V2_RESERVED_PREFIX!r} selects the "
            f"Milvus V2 adapter and is only valid with mode "
            f"{MILVUS_V2_INDEX_MODE!r}, got mode {mode!r}"
        )
    return MilvusBackend


def get_supported_storage_types() -> List[str]:
    return list(STORAGE_BACKEND_REGISTRY.keys())


def get_supported_retrieval_methods(storage_type: str) -> List[str]:
    return resolve_storage_backend_class(storage_type).get_supported_retrieval_methods()


def get_all_storage_retrieval_methods() -> Dict[str, List[str]]:
    return {
        storage_type: backend_class.get_supported_retrieval_methods()
        for storage_type, backend_class in STORAGE_BACKEND_REGISTRY.items()
    }


def storage_backend_owns_document_replacement(
    storage_config: Optional[Dict[str, Any]],
) -> bool:
    """Whether this config's adapter removes a document inside its own write.

    Such a backend is the only owner of that removal, so the indexing layer
    must not delete the document's rows before calling it. The answer is the
    backend class's own capability, so a backend that changes its write shape
    declares it once instead of being listed in a second registry of storage
    type strings. It is read from the whole storage config the runtime resolved
    for the request - the type and the index strategy - and never from the
    retriever's name, because the same ``milvus`` type answers both ways.
    A config naming no type this module answers keeps the existing
    delete-then-index order: the runtime refuses to build such a backend
    anyway. A config that does name one and then breaks that type's own routing
    rule is not answered here - it fails the way building its adapter fails,
    instead of quietly picking the delete order.
    """
    config = storage_config if isinstance(storage_config, dict) else {}
    try:
        backend_class = resolve_storage_backend_class(
            config.get("type") or "",
            config.get("indexStrategy"),
        )
    except UnsupportedStorageTypeError:
        return False
    return backend_class.owns_document_replacement


def create_storage_backend_from_config(
    storage_type: str,
    url: str,
    username: Optional[str] = None,
    password: Optional[str] = None,
    api_key: Optional[str] = None,
    index_strategy: Optional[Dict[str, Any]] = None,
    ext: Optional[Dict[str, Any]] = None,
) -> BaseStorageBackend:
    backend_class = resolve_storage_backend_class(storage_type, index_strategy)
    normalized_type = _normalize_storage_type(storage_type)
    if not url:
        raise ValueError(f"storage url must be provided for {normalized_type} backend")

    config = {
        "url": url,
        "username": username,
        "password": password,
        "apiKey": api_key,
        "indexStrategy": index_strategy or {"mode": "per_dataset"},
        "ext": ext or {},
    }
    return backend_class(config)


def create_storage_backend_from_runtime_config(
    retriever_config: RuntimeRetrieverConfig,
) -> BaseStorageBackend:
    storage_config = retriever_config.storage_config or {}
    storage_type = storage_config.get("type") or ""
    index_strategy = storage_config.get("indexStrategy") or {"mode": "per_dataset"}
    backend_class = resolve_storage_backend_class(storage_type, index_strategy)
    if not storage_config.get("url"):
        raise ValueError(
            f"storage url must be provided for "
            f"{_normalize_storage_type(storage_type) or '<missing>'} backend"
        )

    config = {
        "url": storage_config.get("url"),
        "username": storage_config.get("username"),
        "password": storage_config.get("password"),
        "apiKey": storage_config.get("apiKey"),
        "indexStrategy": index_strategy,
        "ext": storage_config.get("ext") or {},
    }
    return backend_class(config)
