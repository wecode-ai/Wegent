# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Storage backend factory for resolved runtime config."""

from __future__ import annotations

from importlib import import_module
from typing import TYPE_CHECKING, Any, Dict, Optional, Type

from knowledge_engine.storage.capabilities import (
    STORAGE_BACKEND_SPECS,
    get_all_storage_retrieval_methods,
    get_supported_retrieval_methods,
    get_supported_storage_types,
    normalize_storage_type,
)
from shared.models import RuntimeRetrieverConfig

if TYPE_CHECKING:
    from knowledge_engine.storage.base import BaseStorageBackend


def _load_backend_class(storage_type: str) -> Type["BaseStorageBackend"]:
    """Return the backend class for a type, importing it only on first use."""
    spec = STORAGE_BACKEND_SPECS[storage_type]
    return getattr(import_module(spec.module), spec.class_name)


def create_storage_backend_from_config(
    storage_type: str,
    url: str,
    username: Optional[str] = None,
    password: Optional[str] = None,
    api_key: Optional[str] = None,
    index_strategy: Optional[Dict[str, Any]] = None,
    ext: Optional[Dict[str, Any]] = None,
) -> BaseStorageBackend:
    normalized_type = normalize_storage_type(storage_type)
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
    return _load_backend_class(normalized_type)(config)


def create_storage_backend_from_runtime_config(
    retriever_config: RuntimeRetrieverConfig,
) -> BaseStorageBackend:
    storage_config = retriever_config.storage_config or {}
    storage_type = normalize_storage_type(storage_config.get("type") or "")
    if not storage_config.get("url"):
        raise ValueError(f"storage url must be provided for {storage_type} backend")

    config = {
        "url": storage_config.get("url"),
        "username": storage_config.get("username"),
        "password": storage_config.get("password"),
        "apiKey": storage_config.get("apiKey"),
        "indexStrategy": storage_config.get("indexStrategy") or {"mode": "per_dataset"},
        "ext": storage_config.get("ext") or {},
    }
    return _load_backend_class(storage_type)(config)


__all__ = [
    "create_storage_backend_from_config",
    "create_storage_backend_from_runtime_config",
    "get_all_storage_retrieval_methods",
    "get_supported_retrieval_methods",
    "get_supported_storage_types",
]
