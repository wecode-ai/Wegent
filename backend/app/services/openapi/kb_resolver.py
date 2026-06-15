# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Knowledge base name resolver for OpenAPI v1/responses endpoint.

This module provides functionality to resolve knowledge base display names
to their internal IDs with permission checking.
"""

import logging
from dataclasses import dataclass, field
from typing import Any, Dict, List, NamedTuple, Optional, Tuple

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.services.knowledge.folder_service import KnowledgeFolderService
from app.services.knowledge.knowledge_service import KnowledgeService

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class ResolvedKnowledgeBase:
    """Result of resolving a knowledge base name."""

    kb_id: int
    namespace: str
    name: str
    display_name: str
    scope_restricted: bool = False
    folder_ids: Optional[list[int]] = None
    explicit_document_ids: Optional[list[int]] = None
    include_subfolders: bool = True
    resolved_document_ids: list[int] = field(default_factory=list)


class KnowledgeBaseResolutionResult(NamedTuple):
    """Result of batch knowledge base name resolution."""

    resolved: List[ResolvedKnowledgeBase]
    not_found: List[Dict[str, str]]
    no_access: List[Dict[str, str]]


class KnowledgeBaseNameResolver:
    """
    Resolver for knowledge base names to IDs with permission checking.

    This class handles the resolution of knowledge base display names
    (in 'namespace#name' format) to their internal Kind IDs, including
    permission validation for the requesting user.
    """

    def __init__(self, db: Session, user_id: int):
        """
        Initialize the resolver.

        Args:
            db: Database session
            user_id: ID of the user requesting KB access
        """
        self.db = db
        self.user_id = user_id

    def _get_accessible_kb_lookups(
        self,
    ) -> tuple[Dict[Tuple[str, str], int], Dict[int, tuple[str, str]]]:
        """Get lookup dictionaries of accessible knowledge bases for the user.

        This method uses KnowledgeService.get_all_knowledge_bases_grouped() to get
        all knowledge bases the user has access to, then builds a lookup dictionary
        mapping (namespace, name) to kb_id for efficient permission checking.

        Returns:
            Tuple of:
            - Dict mapping (namespace, display_name) to kb_id
            - Dict mapping kb_id to (namespace, display_name)
        """
        # Get all accessible knowledge bases grouped by scope
        grouped_kbs = KnowledgeService.get_all_knowledge_bases_grouped(
            self.db, self.user_id
        )

        lookup: Dict[Tuple[str, str], int] = {}
        id_lookup: Dict[int, tuple[str, str]] = {}

        def _add_kb(kb) -> None:
            lookup[(kb.namespace, kb.name)] = kb.id
            id_lookup[kb.id] = (kb.namespace, kb.name)

        # Add personal knowledge bases (created_by_me)
        for kb in grouped_kbs.personal.created_by_me:
            _add_kb(kb)

        # Add shared knowledge bases (shared_with_me)
        for kb in grouped_kbs.personal.shared_with_me:
            _add_kb(kb)

        # Add group knowledge bases
        for group in grouped_kbs.groups:
            for kb in group.knowledge_bases:
                _add_kb(kb)

        # Add organization knowledge bases
        for kb in grouped_kbs.organization.knowledge_bases:
            _add_kb(kb)

        return lookup, id_lookup

    def _get_accessible_kb_lookup(self) -> Dict[Tuple[str, str], int]:
        """Get accessible knowledge bases keyed by namespace and display name."""
        lookup, _ = self._get_accessible_kb_lookups()
        return lookup

    def resolve(
        self,
        kb_names: List[Dict[str, Any]],
        raise_on_error: bool = True,
    ) -> KnowledgeBaseResolutionResult:
        """
        Resolve a list of knowledge base names to IDs.

        This method compares input kb_names against the user's accessible knowledge bases
        (from get_all_knowledge_bases_grouped) to resolve names to IDs with permission checking.

        Args:
            kb_names: List of dicts with 'namespace' and 'name' keys
            raise_on_error: If True, raise HTTPException on any error.
                           If False, return partial results and errors.

        Returns:
            KnowledgeBaseResolutionResult with resolved KBs and errors

        Raises:
            HTTPException: If raise_on_error=True and any KB not found or no access
        """
        resolved: List[ResolvedKnowledgeBase] = []
        not_found: List[Dict[str, str]] = []
        no_access: List[Dict[str, str]] = []

        if not kb_names:
            return KnowledgeBaseResolutionResult(
                resolved=resolved,
                not_found=not_found,
                no_access=no_access,
            )

        # Get all accessible KBs for the user (single query)
        accessible_kb_lookup, accessible_kb_id_lookup = (
            self._get_accessible_kb_lookups()
        )

        # Resolve each KB ref by comparing against accessible KBs
        for kb_ref in kb_names:
            namespace = kb_ref.get("namespace", "default")
            name = kb_ref.get("name", "")
            ref_id = kb_ref.get("id")

            if ref_id is not None:
                try:
                    kb_id = int(ref_id)
                except (TypeError, ValueError):
                    not_found.append(kb_ref)
                    continue
                accessible_ref = accessible_kb_id_lookup.get(kb_id)
                if accessible_ref is None:
                    logger.warning(
                        "[KBResolver] Knowledge base not found or no access by id: id=%s",
                        ref_id,
                    )
                    no_access.append(kb_ref)
                    continue
                namespace, resolved_name = accessible_ref
                name = name or resolved_name
                resolved.append(
                    self._build_resolved_ref(
                        kb_ref=kb_ref,
                        kb_id=kb_id,
                        namespace=namespace,
                        name=name,
                    )
                )
                logger.debug(
                    "[KBResolver] Resolved KB by id: id=%d, namespace=%s, name=%s",
                    kb_id,
                    namespace,
                    name,
                )
                continue

            if not name:
                logger.warning(
                    "[KBResolver] Empty knowledge base name in reference: %s",
                    kb_ref,
                )
                not_found.append(kb_ref)
                continue

            # Check if KB is in accessible list
            kb_id = accessible_kb_lookup.get((namespace, name))

            if kb_id is None:
                logger.warning(
                    "[KBResolver] Knowledge base not found or no access: namespace=%s, name=%s",
                    namespace,
                    name,
                )
                no_access.append(kb_ref)
                continue

            resolved.append(
                self._build_resolved_ref(
                    kb_ref=kb_ref,
                    kb_id=kb_id,
                    namespace=namespace,
                    name=name,
                )
            )
            logger.debug(
                "[KBResolver] Resolved KB: namespace=%s, name=%s -> id=%d",
                namespace,
                name,
                kb_id,
            )

        # Handle errors based on raise_on_error flag
        if raise_on_error:
            self._handle_errors(resolved, not_found, no_access)

        return KnowledgeBaseResolutionResult(
            resolved=resolved,
            not_found=not_found,
            no_access=no_access,
        )

    def _build_resolved_ref(
        self,
        *,
        kb_ref: Dict[str, Any],
        kb_id: int,
        namespace: str,
        name: str,
    ) -> ResolvedKnowledgeBase:
        """Build a resolved KB ref and resolve optional folder/document scope."""
        scope_restricted = bool(kb_ref.get("scope_specified"))
        folder_ids = kb_ref.get("folder_ids")
        explicit_document_ids = kb_ref.get("document_ids")
        include_subfolders = bool(kb_ref.get("include_subfolders", True))
        resolved_document_ids: list[int] = []

        if scope_restricted:
            try:
                resolved_document_ids = (
                    KnowledgeFolderService.resolve_document_ids_for_scope(
                        db=self.db,
                        knowledge_base_id=kb_id,
                        user_id=self.user_id,
                        folder_ids=folder_ids,
                        document_ids=explicit_document_ids,
                        include_subfolders=include_subfolders,
                    )
                )
            except ValueError as exc:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=str(exc),
                ) from exc

        return ResolvedKnowledgeBase(
            kb_id=kb_id,
            namespace=namespace,
            name=name,
            display_name=name,
            scope_restricted=scope_restricted,
            folder_ids=folder_ids,
            explicit_document_ids=explicit_document_ids,
            include_subfolders=include_subfolders,
            resolved_document_ids=resolved_document_ids,
        )

    def _handle_errors(
        self,
        resolved: List[ResolvedKnowledgeBase],
        not_found: List[Dict[str, str]],
        no_access: List[Dict[str, str]],
    ) -> None:
        """
        Handle resolution errors by raising appropriate exceptions.

        Args:
            resolved: List of successfully resolved KBs
            not_found: List of KB refs that were not found
            no_access: List of KB refs that user has no access to

        Raises:
            HTTPException: With appropriate error message
        """
        if not_found:
            kb_list = [
                f"{r.get('namespace', 'default')}#{r.get('name', '')}"
                for r in not_found
            ]
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Knowledge base(s) not found: {', '.join(kb_list)}",
            )

        if no_access:
            kb_list = [
                f"{r.get('namespace', 'default')}#{r.get('name', '')}"
                for r in no_access
            ]
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Access denied to knowledge base(s): {', '.join(kb_list)}",
            )


def resolve_knowledge_base_names(
    db: Session,
    user_id: int,
    kb_names: List[Dict[str, Any]],
    raise_on_error: bool = True,
) -> KnowledgeBaseResolutionResult:
    """
    Convenience function to resolve knowledge base names.

    Args:
        db: Database session
        user_id: ID of the user requesting KB access
        kb_names: List of dicts with 'namespace' and 'name' keys
        raise_on_error: If True, raise HTTPException on any error

    Returns:
        KnowledgeBaseResolutionResult with resolved KBs and errors
    """
    resolver = KnowledgeBaseNameResolver(db, user_id)
    return resolver.resolve(kb_names, raise_on_error)
