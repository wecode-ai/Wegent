# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Resolved retriever and embedding configuration for the local data plane.

The knowledge base owner's access verdict comes from the existing retriever and
model lookups, so it stays identical to the verdict the runtime applies. Only the
local data plane consumes the resolved storage configuration and credentials; a
remote gateway is handed no configuration at all.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from app.services.adapters.retriever_kinds import retriever_kinds_service
from knowledge_engine.embedding.capabilities import (
    normalize_additional_input_modalities,
)
from shared.db.capability_reference import resolve_model_kind
from shared.models import RuntimeEmbeddingModelConfig, RuntimeRetrieverConfig
from shared.utils.crypto import decrypt_api_key
from shared.utils.placeholder import process_custom_headers_placeholders


def require_retriever_access(
    *,
    db: Session,
    user_id: int,
    name: str,
    namespace: str,
) -> None:
    """Refuse when the owner may not use the retriever.

    The retriever service owns the group permission plus the personal,
    referenced and public lookup, so this is the verdict the local plane and the
    runtime both apply.
    """

    retriever_kinds_service.get_retriever(
        db=db,
        user_id=user_id,
        name=name,
        namespace=namespace,
    )


def owner_retriever_config(
    *,
    db: Session,
    user_id: int,
    name: str,
    namespace: str,
    resolve_execution_configs: bool,
) -> RuntimeRetrieverConfig | None:
    """Resolve the owner's retriever for one executing gateway.

    The access verdict is always checked. Only the local data plane also
    consumes the storage configuration, so a remote gateway skips building it
    and decrypting the credentials its request would drop.
    """

    if not resolve_execution_configs:
        require_retriever_access(db=db, user_id=user_id, name=name, namespace=namespace)
        return None

    return build_retriever_config(
        db=db, user_id=user_id, name=name, namespace=namespace
    )


def build_retriever_config(
    *,
    db: Session,
    user_id: int,
    name: str,
    namespace: str,
) -> RuntimeRetrieverConfig:
    """Build the retriever storage configuration with its decrypted credentials."""

    retriever = retriever_kinds_service.get_retriever(
        db=db,
        user_id=user_id,
        name=name,
        namespace=namespace,
    )
    if retriever is None:
        raise ValueError(f"Retriever {name} (namespace: {namespace}) not found")

    storage_config = retriever.spec.storageConfig
    return RuntimeRetrieverConfig(
        name=name,
        namespace=namespace,
        storage_config={
            "type": storage_config.type,
            "url": storage_config.url,
            "username": storage_config.username,
            "password": _decrypt_optional_value(storage_config.password),
            "apiKey": _decrypt_optional_value(storage_config.apiKey),
            "indexStrategy": (
                storage_config.indexStrategy.model_dump(exclude_none=True)
                if storage_config.indexStrategy is not None
                else {"mode": "per_dataset"}
            ),
            "ext": storage_config.ext or {},
        },
    )


def build_embedding_model_config(
    *,
    db: Session,
    user_id: int,
    model_name: str,
    model_namespace: str,
    user_name: str | None,
) -> RuntimeEmbeddingModelConfig:
    """Build the embedding model configuration with its decrypted API key."""

    model_kind = resolve_model_kind(
        db,
        name=model_name,
        namespace=model_namespace,
        user_id=user_id,
    )
    if model_kind is None:
        raise ValueError(
            f"Embedding model '{model_name}' not found in namespace '{model_namespace}'"
        )

    spec = (model_kind.json or {}).get("spec", {})
    model_config = spec.get("modelConfig", {})
    env = model_config.get("env", {})
    protocol = spec.get("protocol") or env.get("model")
    custom_headers = env.get("custom_headers", {})
    if custom_headers and isinstance(custom_headers, dict):
        custom_headers = process_custom_headers_placeholders(
            custom_headers,
            user_name,
        )

    embedding_config = spec.get("embeddingConfig", {})
    dimensions = embedding_config.get("dimensions") if embedding_config else None
    encoding_format = (
        embedding_config.get("encoding_format") if embedding_config else None
    )
    additional_input_modalities = normalize_additional_input_modalities(
        embedding_config.get("additional_input_modalities")
        if embedding_config
        else None
    )

    return RuntimeEmbeddingModelConfig(
        model_name=model_name,
        model_namespace=model_namespace,
        resolved_config={
            "protocol": protocol,
            "api_key": _decrypt_optional_value(env.get("api_key")),
            "base_url": env.get("base_url"),
            "model_id": env.get("model_id"),
            "custom_headers": (
                custom_headers if isinstance(custom_headers, dict) else {}
            ),
            "dimensions": dimensions,
            "encoding_format": encoding_format,
            "additional_input_modalities": additional_input_modalities,
        },
    )


def _decrypt_optional_value(value: Any) -> Any:
    if not value:
        return value
    try:
        return decrypt_api_key(value)
    except Exception:
        return value
