# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Storage backend factory for resolved runtime config."""

from __future__ import annotations

from importlib import import_module
from typing import TYPE_CHECKING, Any, Dict, Optional, Type
from urllib.parse import urlsplit

from knowledge_engine.storage.capabilities import (
    STORAGE_BACKEND_SPECS,
    get_all_storage_retrieval_methods,
    get_supported_retrieval_methods,
    get_supported_storage_types,
    normalize_storage_type,
)
from knowledge_engine.storage.index_strategy import validate_index_strategy
from knowledge_engine.storage.milvus_limits import validate_milvus_write_config
from shared.knowledge_contracts import RuntimeRetrieverConfig

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
    *,
    request_timeout: float | None = None,
) -> BaseStorageBackend:
    """Validate local configuration before constructing the storage backend."""
    storage_config = retriever_config.storage_config or {}
    storage_type = normalize_storage_type(storage_config.get("type") or "")
    if not storage_config.get("url"):
        raise ValueError(f"storage url must be provided for {storage_type} backend")

    if not isinstance(storage_config["url"], str):
        raise ValueError("Storage URL must be a string")
    for field in ("ext", "indexStrategy"):
        if storage_config.get(field) is not None and not isinstance(
            storage_config[field], dict
        ):
            raise ValueError(f"Storage {field} must be an object")
    _validate_runtime_storage_url(
        storage_type, storage_config["url"], network_only=request_timeout is not None
    )

    config: dict[str, Any] = {
        "url": storage_config.get("url"),
        "username": storage_config.get("username"),
        "password": storage_config.get("password"),
        "apiKey": storage_config.get("apiKey"),
        "indexStrategy": storage_config.get("indexStrategy") or {"mode": "per_dataset"},
        "ext": storage_config.get("ext") or {},
    }
    if request_timeout is not None:
        config["request_timeout"] = request_timeout
    validate_index_strategy(config["indexStrategy"])
    if storage_type == "milvus":
        validate_milvus_write_config(config["ext"])
    return _load_backend_class(storage_type)(config)


def _validate_runtime_storage_url(
    storage_type: str, url: str, *, network_only: bool
) -> None:
    """Validate syntax without contacting the storage service."""
    candidate = (
        f"http://{url}" if storage_type == "qdrant" and "://" not in url else url
    )
    message = (
        "External cleanup requires a valid network storage URL"
        if network_only
        else "Storage URL must identify a valid storage target"
    )
    try:
        target = urlsplit(candidate)
        if storage_type == "milvus" and not network_only:
            if not target.scheme and url.endswith(".db"):
                return
            if target.scheme == "unix" and target.path:
                return
        allowed_schemes = (
            {"http", "https", "tcp", "grpc"}
            if storage_type == "milvus"
            else {"http", "https"}
        )
        if target.scheme not in allowed_schemes or not target.hostname:
            raise ValueError(message)
        target.port
    except ValueError as error:
        raise ValueError(message) from error


__all__ = [
    "create_storage_backend_from_config",
    "create_storage_backend_from_runtime_config",
    "get_all_storage_retrieval_methods",
    "get_supported_retrieval_methods",
    "get_supported_storage_types",
]
