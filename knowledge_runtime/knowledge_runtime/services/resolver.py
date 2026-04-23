# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""CRD reference resolver for Knowledge Runtime.

Resolves CRD references (KnowledgeBase, Retriever, Model) to runtime configurations
by querying the database. Used when operating in reference mode.
"""

from __future__ import annotations

import logging
from typing import Any

from sqlalchemy.orm import Session

from knowledge_runtime.db import get_db_session
from shared.models import (
    RemoteKnowledgeBaseQueryConfig,
    RuntimeEmbeddingModelConfig,
    RuntimeRetrievalConfig,
    RuntimeRetrieverConfig,
)
from shared.models.db import Kind
from shared.utils.crypto import decrypt_api_key

logger = logging.getLogger(__name__)


class RuntimeResolver:
    """Resolve CRD references to runtime configurations.

    This resolver queries the database to resolve CRD references into
    complete runtime configurations, including decrypting sensitive fields.
    """

    def resolve_knowledge_base_query_config(
        self,
        *,
        knowledge_base_id: int,
        user_id: int,
        user_name: str | None = None,
    ) -> RemoteKnowledgeBaseQueryConfig:
        """Resolve a KnowledgeBase reference to a query configuration.

        Args:
            knowledge_base_id: The KnowledgeBase ID.
            user_id: The user ID for permission validation.
            user_name: Optional user name for placeholder processing.

        Returns:
            RemoteKnowledgeBaseQueryConfig with resolved configs.

        Raises:
            ValueError: If KnowledgeBase or referenced resources not found.
        """
        with get_db_session() as db:
            # Query KnowledgeBase CRD
            kb = self._get_knowledge_base(db, knowledge_base_id)
            if kb is None:
                raise ValueError(f"KnowledgeBase {knowledge_base_id} not found")

            # Extract references from KB spec
            spec = (kb.json or {}).get("spec", {})
            retrieval_config = spec.get("retrievalConfig") or {}
            embedding_config = retrieval_config.get("embedding_config") or {}

            retriever_name = retrieval_config.get("retriever_name")
            retriever_namespace = retrieval_config.get("retriever_namespace", "default")
            model_name = embedding_config.get("model_name")
            model_namespace = embedding_config.get("model_namespace", "default")

            if not retriever_name:
                raise ValueError(
                    f"KnowledgeBase {knowledge_base_id} has incomplete retrieval config "
                    "(missing retriever_name)"
                )
            if not model_name:
                raise ValueError(
                    f"KnowledgeBase {knowledge_base_id} has incomplete embedding config "
                    "(missing model_name)"
                )

            # Use KB owner's user_id for resolving references
            index_owner_user_id = kb.user_id

            # Build retrieval config
            retrieval_mode = retrieval_config.get("retrieval_mode", "vector")
            hybrid_weights = retrieval_config.get("hybrid_weights") or {}

            return RemoteKnowledgeBaseQueryConfig(
                knowledge_base_id=knowledge_base_id,
                index_owner_user_id=index_owner_user_id,
                retriever_config=self.resolve_retriever_config(
                    db=db,
                    user_id=index_owner_user_id,
                    name=retriever_name,
                    namespace=retriever_namespace,
                ),
                embedding_model_config=self.resolve_embedding_model_config(
                    db=db,
                    user_id=index_owner_user_id,
                    model_name=model_name,
                    model_namespace=model_namespace,
                    user_name=user_name,
                ),
                retrieval_config=RuntimeRetrievalConfig(
                    top_k=retrieval_config.get("top_k", 20),
                    score_threshold=retrieval_config.get("score_threshold", 0.7),
                    retrieval_mode=retrieval_mode,
                    vector_weight=(
                        hybrid_weights.get("vector_weight")
                        if retrieval_mode == "hybrid"
                        else None
                    ),
                    keyword_weight=(
                        hybrid_weights.get("keyword_weight")
                        if retrieval_mode == "hybrid"
                        else None
                    ),
                ),
            )

    def resolve_retriever_config(
        self,
        *,
        db: Session,
        user_id: int,
        name: str,
        namespace: str = "default",
    ) -> RuntimeRetrieverConfig:
        """Resolve a Retriever reference to a runtime configuration.

        Args:
            db: Database session.
            user_id: The user ID for resolving references.
            name: Retriever name.
            namespace: Retriever namespace.

        Returns:
            RuntimeRetrieverConfig with resolved storage config.

        Raises:
            ValueError: If Retriever not found.
        """
        retriever_kind = self._get_retriever(db, user_id, name, namespace)
        if retriever_kind is None:
            raise ValueError(f"Retriever '{name}' (namespace: {namespace}) not found")

        spec = (retriever_kind.json or {}).get("spec", {})
        storage_config = spec.get("storageConfig", {})

        return RuntimeRetrieverConfig(
            name=name,
            namespace=namespace,
            storage_config={
                "type": storage_config.get("type"),
                "url": storage_config.get("url"),
                "username": storage_config.get("username"),
                "password": self._decrypt(storage_config.get("password")),
                "apiKey": self._decrypt(storage_config.get("apiKey")),
                "indexStrategy": storage_config.get(
                    "indexStrategy", {"mode": "per_dataset"}
                ),
                "ext": storage_config.get("ext", {}),
            },
        )

    def resolve_embedding_model_config(
        self,
        *,
        db: Session,
        user_id: int,
        model_name: str,
        model_namespace: str = "default",
        user_name: str | None = None,
    ) -> RuntimeEmbeddingModelConfig:
        """Resolve an Embedding Model reference to a runtime configuration.

        Args:
            db: Database session.
            user_id: The user ID for resolving references.
            model_name: Model name.
            model_namespace: Model namespace.
            user_name: Optional user name for placeholder processing.

        Returns:
            RuntimeEmbeddingModelConfig with resolved config.

        Raises:
            ValueError: If Model not found.
        """
        model_kind = self._get_model_kind(
            db=db,
            user_id=user_id,
            model_name=model_name,
            model_namespace=model_namespace,
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

        # Process custom headers placeholders
        if custom_headers and isinstance(custom_headers, dict) and user_name:
            custom_headers = self._process_custom_headers_placeholders(
                custom_headers, user_name
            )

        embedding_config = spec.get("embeddingConfig", {})
        dimensions = embedding_config.get("dimensions") if embedding_config else None

        return RuntimeEmbeddingModelConfig(
            model_name=model_name,
            model_namespace=model_namespace,
            resolved_config={
                "protocol": protocol,
                "api_key": self._decrypt(env.get("api_key")),
                "base_url": env.get("base_url"),
                "model_id": env.get("model_id"),
                "custom_headers": (
                    custom_headers if isinstance(custom_headers, dict) else {}
                ),
                "dimensions": dimensions,
            },
        )

    def resolve_retriever_config_for_test(
        self,
        *,
        name: str,
        namespace: str = "default",
        user_id: int,
    ) -> RuntimeRetrieverConfig:
        """Resolve a Retriever reference for connection testing.

        Args:
            name: Retriever name.
            namespace: Retriever namespace.
            user_id: The user ID for resolving references.

        Returns:
            RuntimeRetrieverConfig with resolved storage config.
        """
        with get_db_session() as db:
            return self.resolve_retriever_config(
                db=db,
                user_id=user_id,
                name=name,
                namespace=namespace,
            )

    def _get_knowledge_base(
        self,
        db: Session,
        knowledge_base_id: int,
    ) -> Any:
        """Get a KnowledgeBase CRD by ID.

        Args:
            db: Database session.
            knowledge_base_id: KnowledgeBase ID.

        Returns:
            Kind record or None.
        """
        return (
            db.query(Kind)
            .filter(
                Kind.id == knowledge_base_id,
                Kind.kind == "KnowledgeBase",
                Kind.is_active == True,
            )
            .first()
        )

    def _get_retriever(
        self,
        db: Session,
        user_id: int,
        name: str,
        namespace: str,
    ) -> Any:
        """Get a Retriever CRD with public fallback.

        Query logic:
        - If namespace='default': query with user_id filter, fallback to public
        - If namespace!='default': query without user_id filter

        Args:
            db: Database session.
            user_id: User ID.
            name: Retriever name.
            namespace: Namespace.

        Returns:
            Kind record or None.
        """
        if namespace == "default":
            # Personal retriever: filter by user_id, fallback to public (user_id=0)
            return (
                db.query(Kind)
                .filter(
                    Kind.name == name,
                    Kind.kind == "Retriever",
                    Kind.namespace == namespace,
                    Kind.is_active == True,
                )
                .filter((Kind.user_id == user_id) | (Kind.user_id == 0))
                .order_by(Kind.user_id.desc())  # Prioritize user's retriever
                .first()
            )
        else:
            # Group retriever: no user_id filter
            kind = (
                db.query(Kind)
                .filter(
                    Kind.name == name,
                    Kind.kind == "Retriever",
                    Kind.namespace == namespace,
                    Kind.is_active == True,
                )
                .first()
            )
            # Fallback to public retriever if not found in group
            if not kind:
                kind = (
                    db.query(Kind)
                    .filter(
                        Kind.user_id == 0,
                        Kind.name == name,
                        Kind.kind == "Retriever",
                        Kind.namespace == "default",
                        Kind.is_active == True,
                    )
                    .first()
                )
            return kind

    def _get_model_kind(
        self,
        *,
        db: Session,
        user_id: int,
        model_name: str,
        model_namespace: str,
    ) -> Any:
        """Get a Model CRD with public fallback.

        Args:
            db: Database session.
            user_id: User ID.
            model_name: Model name.
            model_namespace: Model namespace.

        Returns:
            Kind record or None.
        """
        if model_namespace == "default":
            return (
                db.query(Kind)
                .filter(
                    Kind.kind == "Model",
                    Kind.name == model_name,
                    Kind.namespace == model_namespace,
                    Kind.is_active == True,
                )
                .filter((Kind.user_id == user_id) | (Kind.user_id == 0))
                .order_by(Kind.user_id.desc())
                .first()
            )
        return (
            db.query(Kind)
            .filter(
                Kind.kind == "Model",
                Kind.name == model_name,
                Kind.namespace == model_namespace,
                Kind.is_active == True,
            )
            .first()
        )

    def _decrypt(self, value: Any) -> Any:
        """Decrypt an encrypted value if applicable.

        Args:
            value: The value to decrypt.

        Returns:
            Decrypted value or original if not encrypted.
        """
        if not value:
            return value
        try:
            return decrypt_api_key(value)
        except Exception:
            # Not encrypted or decryption failed, return original
            return value

    def _process_custom_headers_placeholders(
        self,
        custom_headers: dict[str, Any],
        user_name: str | None,
    ) -> dict[str, Any]:
        """Process placeholders in custom headers.

        Args:
            custom_headers: Custom headers dict.
            user_name: User name for placeholder replacement.

        Returns:
            Processed custom headers dict.
        """
        if not user_name:
            return custom_headers

        result = {}
        for key, value in custom_headers.items():
            if isinstance(value, str):
                value = value.replace("{user_name}", user_name)
            result[key] = value
        return result


# Global resolver instance
_resolver: RuntimeResolver | None = None


def get_resolver() -> RuntimeResolver:
    """Get the global resolver instance."""
    global _resolver
    if _resolver is None:
        _resolver = RuntimeResolver()
    return _resolver
