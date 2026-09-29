# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Config resolver for knowledge_runtime.

Resolves runtime configurations (retriever, embedding model, splitter)
from the database using knowledge_base_id and user_id as references.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy.orm import Session

from knowledge_runtime.models.knowledge_document import KnowledgeDocument
from shared.db.capability_reference import resolve_model_kind
from shared.knowledge_module import (
    EMBEDDING_RESOURCE_CATEGORY,
    AuthorizedRetrievalResources,
    KnowledgeConfigError,
    RetrievalResource,
    resolve_execution_config,
)
from shared.models import (
    RemoteQueryAuthorizedResources,
    RuntimeEmbeddingModelConfig,
    RuntimeRetrievalConfig,
    RuntimeRetrieverConfig,
)
from shared.models.db import Kind, User
from shared.utils.crypto import decrypt_api_key
from shared.utils.placeholder import process_custom_headers_placeholders

logger = logging.getLogger(__name__)


@dataclass
class IndexConfig:
    """Resolved configuration for document indexing."""

    index_owner_user_id: int
    retriever_config: RuntimeRetrieverConfig
    embedding_model_config: RuntimeEmbeddingModelConfig
    splitter_config: dict[str, Any] = field(default_factory=dict)
    user_name: str | None = None


@dataclass
class QueryConfig:
    """Resolved configuration for querying a single knowledge base."""

    knowledge_base_id: int
    index_owner_user_id: int
    retriever_config: RuntimeRetrieverConfig
    embedding_model_config: RuntimeEmbeddingModelConfig
    retrieval_config: RuntimeRetrievalConfig
    user_name: str | None = None


@dataclass
class AdminResolvedConfig:
    """Resolved configuration for admin operations (delete/purge/drop/list)."""

    index_owner_user_id: int
    retriever_config: RuntimeRetrieverConfig


class ConfigResolutionError(ValueError):
    """Raised when config resolution fails with a specific error code."""

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        super().__init__(message)


class ConfigResolver:
    """Resolve runtime configs from database by knowledge_base_id + user_id."""

    def resolve_index_config(
        self,
        db: Session,
        *,
        knowledge_base_id: int,
        user_id: int,
        document_id: int | None = None,
    ) -> IndexConfig:
        """Resolve all configs needed for document indexing."""
        kb = self._get_knowledge_base(db, knowledge_base_id)
        index_owner_user_id = kb.user_id
        user_name = self._get_user_name(db, user_id)

        retrieval_config = self._parse_kb_retrieval_config(kb)

        retriever_config = self._build_resolved_retriever_config(
            db=db,
            user_id=index_owner_user_id,
            name=retrieval_config["retriever_name"],
            namespace=retrieval_config["retriever_namespace"],
        )
        embedding_model_config = self._build_resolved_embedding_model_config(
            db=db,
            user_id=index_owner_user_id,
            model_name=retrieval_config["embedding_model_name"],
            model_namespace=retrieval_config["embedding_model_namespace"],
            user_name=user_name,
        )

        splitter_config: dict[str, Any] = {}
        if document_id is not None:
            splitter_config = self._get_splitter_config(db, document_id)

        return IndexConfig(
            index_owner_user_id=index_owner_user_id,
            retriever_config=retriever_config,
            embedding_model_config=embedding_model_config,
            splitter_config=splitter_config,
            user_name=user_name,
        )

    def resolve_query_config(
        self,
        db: Session,
        *,
        knowledge_base_id: int,
        user_id: int,
        authorized: RemoteQueryAuthorizedResources | None = None,
    ) -> QueryConfig:
        """Resolve configs needed for querying a single knowledge base.

        The query only loads the retrieval resources Backend authorized for this
        operation (``authorized``). The stored configuration must still name
        those same resources, so a knowledge base edited to a resource outside
        the authorized set fails instead of silently executing the new one.
        """
        if authorized is None:
            raise ConfigResolutionError(
                "authorization_required",
                f"Knowledge base {knowledge_base_id} query requires authorized "
                "retrieval resources",
            )
        kb = self._get_knowledge_base(db, knowledge_base_id)
        index_owner_user_id = authorized.index_owner_user_id
        user_name = self._get_user_name(db, user_id)

        return QueryConfig(
            knowledge_base_id=knowledge_base_id,
            index_owner_user_id=index_owner_user_id,
            retriever_config=self._authorized_retriever_config(
                db, authorized, index_owner_user_id
            ),
            embedding_model_config=self._authorized_embedding_config(
                db, authorized, index_owner_user_id, user_name
            ),
            retrieval_config=self._authorized_retrieval_settings(kb, authorized),
            user_name=user_name,
        )

    def _authorized_retriever_config(
        self,
        db: Session,
        authorized: RemoteQueryAuthorizedResources,
        index_owner_user_id: int,
    ) -> RuntimeRetrieverConfig:
        """Load the runner's retriever Kind inside the authorized reference."""
        retriever_kind = self._get_retriever_kind(
            db,
            user_id=index_owner_user_id,
            name=authorized.retriever.name,
            namespace=authorized.retriever.namespace,
        )
        if retriever_kind is None:
            raise ConfigResolutionError(
                "config_not_found",
                f"Retriever {authorized.retriever.name} "
                f"(namespace: {authorized.retriever.namespace}) not found",
            )
        return self._build_retriever_config_from_kind(
            retriever_kind,
            name=authorized.retriever.name,
            namespace=authorized.retriever.namespace,
        )

    def _authorized_embedding_config(
        self,
        db: Session,
        authorized: RemoteQueryAuthorizedResources,
        index_owner_user_id: int,
        user_name: str | None,
    ) -> RuntimeEmbeddingModelConfig:
        """Load the runner's embedding Kind inside the authorized reference."""
        embedding_kind = self._get_model_kind(
            db=db,
            user_id=index_owner_user_id,
            model_name=authorized.embedding_model.name,
            model_namespace=authorized.embedding_model.namespace,
        )
        if embedding_kind is None:
            raise ConfigResolutionError(
                "config_not_found",
                f"Embedding model '{authorized.embedding_model.name}' not found in "
                f"namespace '{authorized.embedding_model.namespace}'",
            )
        return self._build_embedding_config_from_kind(
            embedding_kind,
            model_name=authorized.embedding_model.name,
            model_namespace=authorized.embedding_model.namespace,
            user_name=user_name,
        )

    def _authorized_retrieval_settings(
        self,
        kb: Kind,
        authorized: RemoteQueryAuthorizedResources,
    ) -> RuntimeRetrievalConfig:
        """Resolve stored retrieval parameters inside the authorized set."""
        try:
            resolved = resolve_execution_config(
                self._read_kb_retrieval_config(kb),
                AuthorizedRetrievalResources(
                    retriever=RetrievalResource(
                        name=authorized.retriever.name,
                        kind=authorized.retriever.kind,
                        namespace=authorized.retriever.namespace,
                    ),
                    embedding_model=RetrievalResource(
                        name=authorized.embedding_model.name,
                        kind=authorized.embedding_model.kind,
                        category=EMBEDDING_RESOURCE_CATEGORY,
                        namespace=authorized.embedding_model.namespace,
                    ),
                ),
            )
        except KnowledgeConfigError as exc:
            raise ConfigResolutionError("config_invalid", str(exc)) from exc
        return RuntimeRetrievalConfig(**resolved.retrieval_config)

    def resolve_admin_config(
        self,
        db: Session,
        *,
        knowledge_base_id: int,
    ) -> AdminResolvedConfig:
        """Resolve config for admin operations (delete/purge/drop/list)."""
        kb = self._get_knowledge_base(db, knowledge_base_id)
        retrieval_config = self._parse_kb_retrieval_config(kb)

        retriever_config = self._build_resolved_retriever_config(
            db=db,
            user_id=kb.user_id,
            name=retrieval_config["retriever_name"],
            namespace=retrieval_config["retriever_namespace"],
        )

        return AdminResolvedConfig(
            index_owner_user_id=kb.user_id,
            retriever_config=retriever_config,
        )

    # --- Private methods ---

    def _get_knowledge_base(self, db: Session, knowledge_base_id: int) -> Kind:
        """Get KB record or raise ConfigResolutionError."""
        kb = (
            db.query(Kind)
            .filter(
                Kind.id == knowledge_base_id,
                Kind.kind == "KnowledgeBase",
                Kind.is_active.is_(True),
            )
            .first()
        )
        if kb is None:
            raise ConfigResolutionError(
                "config_not_found",
                f"Knowledge base {knowledge_base_id} not found",
            )
        return kb

    def _parse_kb_retrieval_config(self, kb: Kind) -> dict[str, Any]:
        """Parse KB's retrievalConfig from its JSON spec."""
        retrieval_config = self._read_kb_retrieval_config(kb)
        retriever_name = retrieval_config.get("retriever_name")
        retriever_namespace = retrieval_config.get("retriever_namespace", "default")
        embedding_config = retrieval_config.get("embedding_config") or {}
        embedding_model_name = embedding_config.get("model_name")
        embedding_model_namespace = embedding_config.get("model_namespace", "default")

        if not retriever_name:
            raise ConfigResolutionError(
                "config_incomplete",
                f"Knowledge base {kb.id} has incomplete retrieval config (missing retriever_name)",
            )
        if not embedding_model_name:
            raise ConfigResolutionError(
                "config_incomplete",
                f"Knowledge base {kb.id} has incomplete embedding config",
            )

        return {
            "retriever_name": retriever_name,
            "retriever_namespace": retriever_namespace,
            "embedding_model_name": embedding_model_name,
            "embedding_model_namespace": embedding_model_namespace,
            "top_k": retrieval_config.get("top_k", 20),
            "score_threshold": retrieval_config.get("score_threshold", 0.7),
            "retrieval_mode": retrieval_config.get("retrieval_mode", "vector"),
            "hybrid_weights": retrieval_config.get("hybrid_weights"),
        }

    @staticmethod
    def _read_kb_retrieval_config(kb: Kind) -> dict[str, Any]:
        """Return the raw stored retrievalConfig without applying defaults."""
        return (kb.json or {}).get("spec", {}).get("retrievalConfig") or {}

    def _build_resolved_retriever_config(
        self,
        *,
        db: Session,
        user_id: int,
        name: str,
        namespace: str,
    ) -> RuntimeRetrieverConfig:
        """Build resolved retriever config with decrypted credentials."""
        retriever = self._get_retriever_kind(
            db, user_id=user_id, name=name, namespace=namespace
        )
        if retriever is None:
            raise ConfigResolutionError(
                "config_not_found",
                f"Retriever {name} (namespace: {namespace}) not found",
            )
        return self._build_retriever_config_from_kind(
            retriever, name=name, namespace=namespace
        )

    def _build_retriever_config_from_kind(
        self,
        retriever: Kind,
        *,
        name: str,
        namespace: str,
    ) -> RuntimeRetrieverConfig:
        """Build a runtime retriever config from an authorized Retriever Kind."""
        spec = retriever.json or {}
        storage_config = spec.get("spec", {}).get("storageConfig", {})

        return RuntimeRetrieverConfig(
            name=name,
            namespace=namespace,
            storage_config={
                "type": storage_config.get("type"),
                "url": storage_config.get("url"),
                "username": storage_config.get("username"),
                "password": self._decrypt_optional_value(
                    storage_config.get("password")
                ),
                "apiKey": self._decrypt_optional_value(storage_config.get("apiKey")),
                "indexStrategy": storage_config.get(
                    "indexStrategy", {"mode": "per_dataset"}
                ),
                "ext": storage_config.get("ext", {}),
            },
        )

    def _build_resolved_embedding_model_config(
        self,
        *,
        db: Session,
        user_id: int,
        model_name: str,
        model_namespace: str,
        user_name: str | None,
    ) -> RuntimeEmbeddingModelConfig:
        """Build resolved embedding model config with decrypted API key."""
        model_kind = self._get_model_kind(
            db=db,
            user_id=user_id,
            model_name=model_name,
            model_namespace=model_namespace,
        )
        if model_kind is None:
            raise ConfigResolutionError(
                "config_not_found",
                f"Embedding model '{model_name}' not found in namespace '{model_namespace}'",
            )
        return self._build_embedding_config_from_kind(
            model_kind,
            model_name=model_name,
            model_namespace=model_namespace,
            user_name=user_name,
        )

    def _build_embedding_config_from_kind(
        self,
        model_kind: Kind,
        *,
        model_name: str,
        model_namespace: str,
        user_name: str | None,
    ) -> RuntimeEmbeddingModelConfig:
        """Build a runtime embedding config from an authorized Model Kind."""
        spec = (model_kind.json or {}).get("spec", {})
        model_config = spec.get("modelConfig", {})
        env = model_config.get("env", {})
        protocol = spec.get("protocol") or env.get("model")
        custom_headers = env.get("custom_headers", {})
        if custom_headers and isinstance(custom_headers, dict):
            custom_headers = process_custom_headers_placeholders(
                custom_headers, user_name
            )

        embedding_config = spec.get("embeddingConfig", {})
        dimensions = embedding_config.get("dimensions") if embedding_config else None
        encoding_format = (
            embedding_config.get("encoding_format") if embedding_config else None
        )

        return RuntimeEmbeddingModelConfig(
            model_name=model_name,
            model_namespace=model_namespace,
            resolved_config={
                "protocol": protocol,
                "api_key": self._decrypt_optional_value(env.get("api_key")),
                "base_url": env.get("base_url"),
                "model_id": env.get("model_id"),
                "custom_headers": (
                    custom_headers if isinstance(custom_headers, dict) else {}
                ),
                "dimensions": dimensions,
                "encoding_format": encoding_format,
            },
        )

    def _get_retriever_kind(
        self,
        db: Session,
        *,
        user_id: int,
        name: str,
        namespace: str,
    ) -> Kind | None:
        """Get Retriever Kind with priority: user's own > public (user_id=0)."""
        if namespace == "default":
            return (
                db.query(Kind)
                .filter(
                    Kind.kind == "Retriever",
                    Kind.name == name,
                    Kind.namespace == namespace,
                    Kind.is_active.is_(True),
                )
                .filter((Kind.user_id == user_id) | (Kind.user_id == 0))
                .order_by(Kind.user_id.desc())
                .first()
            )
        # Group retriever: no user_id filter, fallback to public
        kind = (
            db.query(Kind)
            .filter(
                Kind.kind == "Retriever",
                Kind.name == name,
                Kind.namespace == namespace,
                Kind.is_active.is_(True),
            )
            .first()
        )
        if kind is not None:
            return kind
        # Fallback to public retriever
        return (
            db.query(Kind)
            .filter(
                Kind.user_id == 0,
                Kind.name == name,
                Kind.kind == "Retriever",
                Kind.namespace == "default",
                Kind.is_active.is_(True),
            )
            .first()
        )

    def _get_model_kind(
        self,
        *,
        db: Session,
        user_id: int,
        model_name: str,
        model_namespace: str,
    ) -> Kind | None:
        """Resolve a Model Kind from its caller-visible reference."""
        return resolve_model_kind(
            db,
            name=model_name,
            namespace=model_namespace,
            user_id=user_id,
        )

    def _get_splitter_config(self, db: Session, document_id: int) -> dict[str, Any]:
        """Get splitter_config from knowledge_documents table."""
        doc = (
            db.query(KnowledgeDocument)
            .filter(KnowledgeDocument.id == document_id)
            .first()
        )
        if doc is None:
            raise ConfigResolutionError(
                "config_not_found",
                f"Document {document_id} not found",
            )
        return doc.splitter_config or {}

    def _get_user_name(self, db: Session, user_id: int) -> str | None:
        """Get user_name from users table."""
        user = db.query(User).filter(User.id == user_id).first()
        return user.user_name if user else None

    @staticmethod
    def _decrypt_optional_value(value: Any) -> Any:
        """Decrypt an optional encrypted value. Returns original if decryption fails."""
        if not value:
            return value
        try:
            return decrypt_api_key(value)
        except Exception:
            return value
