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
from sqlalchemy import and_, or_
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.services.external_entity_resolver import (
    EntityMembershipUnavailable,
    entity_resolution_scope,
)
from app.services.knowledge.folder_service import KnowledgeFolderService
from app.services.knowledge.knowledge_service import KnowledgeService
from app.services.knowledge.knowledge_visibility_query import (
    build_knowledge_discovery_query,
)

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
        refs: List[Dict[str, Any]],
        unavailable: dict[int, EntityMembershipUnavailable],
    ) -> tuple[Dict[Tuple[str, str], int], Dict[int, tuple[str, str]]]:
        """Resolve only requested identities without requiring display-role metadata."""
        ids = set()
        names = []
        for ref in refs:
            if ref.get("id") is not None:
                try:
                    ids.add(int(ref["id"]))
                except (TypeError, ValueError):
                    continue
            elif ref.get("name"):
                names.append(
                    and_(
                        Kind.namespace == ref.get("namespace", "default"),
                        Kind.json["spec"]["name"].as_string() == ref["name"],
                    )
                )
        candidates = self.db.query(Kind.id).filter(
            Kind.kind == "KnowledgeBase",
            Kind.is_active.is_(True),
            or_(Kind.id.in_(ids), *names),
        )
        query, _ = build_knowledge_discovery_query(
            self.db,
            self.user_id,
            candidates,
            allow_empty_requirement=True,
            include_inherited_groups=False,
            unavailable=unavailable,
        )
        lookup = {}
        id_lookup = {}
        for kb in query.order_by(Kind.updated_at.desc(), Kind.id.asc()).all():
            name = kb.json.get("spec", {}).get("name", "")
            lookup[(kb.namespace, name)] = kb.id
            id_lookup[kb.id] = (kb.namespace, name)
        # Only a display-name collision needs the existing grouped source ordering.
        counts: dict[tuple[str, str], int] = {}
        for identity in id_lookup.values():
            counts[identity] = counts.get(identity, 0) + 1
        collisions = {identity for identity, count in counts.items() if count > 1}
        if collisions:
            grouped = KnowledgeService.get_all_knowledge_bases_grouped(
                self.db,
                self.user_id,
                candidate_ids=[
                    kb_id
                    for kb_id, identity in id_lookup.items()
                    if identity in collisions
                ],
            )
            ordered = [
                *grouped.personal.created_by_me,
                *grouped.personal.shared_with_me,
            ]
            ordered.extend(
                kb for group in grouped.groups for kb in group.knowledge_bases
            )
            ordered.extend(grouped.organization.knowledge_bases)
            for kb in ordered:
                lookup[(kb.namespace, kb.name)] = kb.id
        return lookup, id_lookup

    def resolve(
        self,
        kb_names: List[Dict[str, Any]],
        raise_on_error: bool = True,
    ) -> KnowledgeBaseResolutionResult:
        with entity_resolution_scope(self.db):
            return self._resolve(kb_names, raise_on_error)

    def _resolve(
        self,
        kb_names: List[Dict[str, Any]],
        raise_on_error: bool = True,
    ) -> KnowledgeBaseResolutionResult:
        """
        Resolve a list of knowledge base names to IDs.

        Resolve requested identities before evaluating their native access and scope.

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

        unavailable: dict[int, EntityMembershipUnavailable] = {}
        # Resolve only candidate resources; defer unknown until the whole request.
        accessible_kb_lookup, accessible_kb_id_lookup = self._get_accessible_kb_lookups(
            kb_names, unavailable
        )

        pending_names = (
            {
                (kb.namespace, kb.json.get("spec", {}).get("name", ""))
                for kb in self.db.query(Kind).filter(Kind.id.in_(unavailable)).all()
            }
            if unavailable
            else set()
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
                    if kb_id in unavailable:
                        continue
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
            named_kb_id = accessible_kb_lookup.get((namespace, name))

            if named_kb_id is None:
                if (namespace, name) in pending_names:
                    continue
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
                    kb_id=named_kb_id,
                    namespace=namespace,
                    name=name,
                )
            )
            logger.debug(
                "[KBResolver] Resolved KB: namespace=%s, name=%s -> id=%d",
                namespace,
                name,
                named_kb_id,
            )

        # Handle errors based on raise_on_error flag
        if raise_on_error:
            self._handle_errors(resolved, not_found, no_access)
        if unavailable:
            raise next(iter(unavailable.values()))

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
                        folder_ids=folder_ids or None,
                        document_ids=explicit_document_ids or None,
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
