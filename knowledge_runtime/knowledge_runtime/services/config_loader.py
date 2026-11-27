# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Short-lived database session boundary for runtime config resolution."""

from __future__ import annotations

import logging
from collections.abc import Callable
from typing import Any, Mapping, TypeVar

from sqlalchemy.orm import Session, sessionmaker

from knowledge_runtime.services.config_resolver import (
    AdminResolvedConfig,
    ConfigResolutionError,
    ConfigResolver,
    IndexConfig,
    QueryConfig,
)
from shared.db.sync_session import get_session_factory
from shared.models import (
    RemoteAuthorizedIndexResources,
    RemoteAuthorizedRetrievalResources,
    RetrievalScope,
)

logger = logging.getLogger(__name__)

T = TypeVar("T")


class RuntimeConfigLoader:
    """Resolve knowledge runtime configs inside a short DB transaction."""

    def __init__(
        self,
        session_factory: sessionmaker | None = None,
        resolver: ConfigResolver | None = None,
    ) -> None:
        self._session_factory = session_factory or get_session_factory()
        self._resolver = resolver or ConfigResolver()

    def resolve_index_config(
        self,
        *,
        knowledge_base_id: int,
        user_id: int,
        document_id: int | None = None,
        authorized: RemoteAuthorizedRetrievalResources | None = None,
        index_generation: int | None = None,
    ) -> IndexConfig:
        """Resolve all configs needed for document indexing."""
        return self._resolve_with_session(
            lambda db: self._resolver.resolve_index_config(
                db=db,
                knowledge_base_id=knowledge_base_id,
                user_id=user_id,
                document_id=document_id,
                authorized=authorized,
                **(
                    {"index_generation": index_generation}
                    if index_generation is not None
                    else {}
                ),
            )
        )

    def resolve_query_config(
        self,
        *,
        knowledge_base_id: int,
        user_id: int,
        authorized: RemoteAuthorizedRetrievalResources | None = None,
        retrieval_override: Mapping[str, Any] | None = None,
        scope: RetrievalScope | None = None,
    ) -> QueryConfig:
        """Resolve configs needed for querying a single knowledge base."""
        return self._resolve_with_session(
            lambda db: self._resolver.resolve_query_config(
                db=db,
                knowledge_base_id=knowledge_base_id,
                user_id=user_id,
                authorized=authorized,
                retrieval_override=retrieval_override,
                scope=scope,
            )
        )

    def resolve_query_configs(
        self,
        *,
        knowledge_base_ids: list[int],
        user_id: int,
        authorized: dict[int, RemoteAuthorizedRetrievalResources] | None = None,
        retrieval_overrides: Mapping[int, Mapping[str, Any]] | None = None,
        scope: RetrievalScope | None = None,
    ) -> dict[int, QueryConfig]:
        """Resolve query configs for multiple knowledge bases in one session.

        Each knowledge base must have an authorized-resources entry; the runtime
        only loads the retrieval resources Backend authorized for this call.
        """
        authorized = authorized or {}
        retrieval_overrides = retrieval_overrides or {}
        return self._resolve_with_session(
            lambda db: {
                knowledge_base_id: self._resolver.resolve_query_config(
                    db=db,
                    knowledge_base_id=knowledge_base_id,
                    user_id=user_id,
                    authorized=authorized.get(knowledge_base_id),
                    retrieval_override=retrieval_overrides.get(knowledge_base_id),
                    scope=scope,
                )
                for knowledge_base_id in knowledge_base_ids
            }
        )

    def resolve_retired_config(self, request) -> AdminResolvedConfig:
        from knowledge_runtime.services.web_version_cleanup import (
            resolve_retired_config,
        )

        return self._resolve_with_session(
            lambda db: resolve_retired_config(db, self._resolver, request)
        )

    def require_unversioned_delete(
        self, knowledge_base_id: int, document_ref: str
    ) -> None:
        from knowledge_runtime.models.knowledge_document import KnowledgeDocument

        logical_ref, _, generation = document_ref.partition("@")
        if logical_ref.isdigit() and generation.isdigit():
            raise ConfigResolutionError(
                "config_invalid",
                "Version deletion requires a recorded storage identity",
            )
        if not document_ref.isdigit():
            return

        def resolve(db):
            document = (
                db.query(KnowledgeDocument)
                .filter(
                    KnowledgeDocument.id == int(document_ref),
                    KnowledgeDocument.kind_id == knowledge_base_id,
                )
                .first()
            )
            if document and (document.source_config or {}).get("published_generation"):
                raise ConfigResolutionError(
                    "config_invalid",
                    "Version deletion requires a recorded storage identity",
                )

        self._resolve_with_session(resolve)

    def resolve_admin_config(
        self,
        *,
        knowledge_base_id: int,
        operation: str,
        authorized: RemoteAuthorizedIndexResources | None = None,
    ) -> AdminResolvedConfig:
        """Resolve config for admin operations."""
        return self._resolve_with_session(
            lambda db: self._resolver.resolve_admin_config(
                db=db,
                knowledge_base_id=knowledge_base_id,
                operation=operation,
                authorized=authorized,
            )
        )

    def _resolve_with_session(self, resolve: Callable[[Session], T]) -> T:
        db = self._session_factory()
        succeeded = False
        rollback_error: Exception | None = None
        close_error: Exception | None = None

        try:
            result = resolve(db)
            succeeded = True
            return result
        finally:
            try:
                db.rollback()
            except Exception as exc:  # pragma: no cover - defensive logging branch
                rollback_error = exc
                logger.exception("Failed to rollback runtime config DB session")

            try:
                db.close()
            except Exception as exc:  # pragma: no cover - defensive logging branch
                close_error = exc
                logger.exception("Failed to close runtime config DB session")

            if succeeded:
                if rollback_error is not None:
                    raise rollback_error
                if close_error is not None:
                    raise close_error
