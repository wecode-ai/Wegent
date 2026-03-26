# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Knowledge base name resolver for OpenAPI v1/responses endpoint.

This module provides functionality to resolve knowledge base display names
to their internal IDs with permission checking.
"""

import logging
from typing import Dict, List, NamedTuple, Tuple

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.services.knowledge.knowledge_service import KnowledgeService

logger = logging.getLogger(__name__)


class ResolvedKnowledgeBase(NamedTuple):
    """Result of resolving a knowledge base name."""

    kb_id: int
    namespace: str
    name: str
    display_name: str


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

    def _get_accessible_kb_lookup(self) -> Dict[Tuple[str, str], int]:
        """
        Get a lookup dictionary of accessible knowledge bases for the user.

        This method uses KnowledgeService.get_all_knowledge_bases_grouped() to get
        all knowledge bases the user has access to, then builds a lookup dictionary
        mapping (namespace, name) to kb_id for efficient permission checking.

        Returns:
            Dict mapping (namespace, display_name) to kb_id
        """
        # Get all accessible knowledge bases grouped by scope
        grouped_kbs = KnowledgeService.get_all_knowledge_bases_grouped(
            self.db, self.user_id
        )

        lookup: Dict[Tuple[str, str], int] = {}

        # Add personal knowledge bases (created_by_me)
        for kb in grouped_kbs.personal.created_by_me:
            lookup[(kb.namespace, kb.name)] = kb.id

        # Add shared knowledge bases (shared_with_me)
        for kb in grouped_kbs.personal.shared_with_me:
            lookup[(kb.namespace, kb.name)] = kb.id

        # Add group knowledge bases
        for group in grouped_kbs.groups:
            for kb in group.knowledge_bases:
                lookup[(kb.namespace, kb.name)] = kb.id

        # Add organization knowledge bases
        for kb in grouped_kbs.organization.knowledge_bases:
            lookup[(kb.namespace, kb.name)] = kb.id

        return lookup

    def resolve(
        self,
        kb_names: List[Dict[str, str]],
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
        accessible_kb_lookup = self._get_accessible_kb_lookup()

        # Resolve each KB ref by comparing against accessible KBs
        for kb_ref in kb_names:
            namespace = kb_ref.get("namespace", "default")
            name = kb_ref.get("name", "")

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
                ResolvedKnowledgeBase(
                    kb_id=kb_id,
                    namespace=namespace,
                    name=name,
                    display_name=name,
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
    kb_names: List[Dict[str, str]],
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
