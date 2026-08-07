# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Resolve internal and external knowledge bindings for task materialization."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.user import User
from app.schemas.kind import Bot, Ghost, Team
from app.services.chat.external_knowledge_refs import (
    build_external_knowledge_warning,
    build_internal_knowledge_warning,
    filter_valid_external_knowledge_refs,
    merge_external_knowledge_refs,
)
from app.services.kind_reference import resolve_kind_reference
from app.services.rag.sources import ExternalRefValidationError
from app.services.share.knowledge_share_service import KnowledgeShareService


class KnowledgeBindingResolver:
    """Resolve Ghost defaults and explicit selections into Task spec bindings."""

    def __init__(self, db: Session) -> None:
        self._db = db

    def resolve_initial_task_bindings(
        self,
        *,
        user: User,
        team,
    ) -> dict[str, list[dict[str, Any]]]:
        """Resolve all initial Task knowledge bindings."""
        bound_at = datetime.now().isoformat()
        default_actor = self.resolve_team_owner_user(team=team, known_user=user)
        internal_refs, internal_warnings = self._resolve_internal_defaults(
            team=team,
            default_actor=default_actor,
            bound_at=bound_at,
        )
        external_refs, external_warnings = self._resolve_external_defaults(
            team=team,
            default_actor=default_actor,
        )
        return {
            "knowledge_base_refs": internal_refs,
            "knowledge_base_scopes": [
                ref for ref in internal_refs if ref.get("scopeRestricted")
            ],
            "external_knowledge_refs": external_refs,
            "context_warnings": internal_warnings + external_warnings,
        }

    def filter_internal_bindings(
        self,
        *,
        refs: list[dict[str, Any]],
        actor_user_id: int,
    ) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        """Filter internal refs through the shared permission service in one batch."""
        refs_by_id = {
            int(ref["id"]): ref
            for ref in refs
            if isinstance(ref, dict) and ref.get("id") is not None
        }
        accessible = KnowledgeShareService().get_accessible_resources_by_ids(
            self._db,
            refs_by_id,
            actor_user_id,
        )
        valid = [
            refs_by_id[knowledge_base_id]
            for knowledge_base_id in refs_by_id
            if knowledge_base_id in accessible
        ]
        warnings = [
            build_internal_knowledge_warning(knowledge_base_id=knowledge_base_id)
            for knowledge_base_id in refs_by_id
            if knowledge_base_id not in accessible
        ]
        return valid, warnings

    def _resolve_internal_defaults(
        self,
        *,
        team,
        default_actor: User | None,
        bound_at: str,
    ) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        refs_by_id: dict[int, dict[str, Any]] = {}
        warnings: list[dict[str, Any]] = []
        default_refs = self._team_member_default_knowledge_base_refs(team=team)
        candidate_refs: list[dict[str, Any]] = []
        if default_actor is None:
            warnings.extend(
                build_internal_knowledge_warning(
                    knowledge_base_id=ref["id"],
                    reason="actor_not_found",
                )
                for ref in default_refs
            )
        else:
            candidate_refs.extend(
                {
                    "ref": ref,
                    "actor_user_id": default_actor.id,
                    "actor_user_name": default_actor.user_name,
                }
                for ref in default_refs
            )
        accessible_by_actor: dict[int, dict[int, Kind]] = {}
        for actor_user_id in {
            candidate["actor_user_id"] for candidate in candidate_refs
        }:
            candidate_ids = [
                candidate["ref"]["id"]
                for candidate in candidate_refs
                if candidate["actor_user_id"] == actor_user_id
            ]
            accessible_by_actor[
                actor_user_id
            ] = KnowledgeShareService().get_accessible_resources_by_ids(
                self._db,
                candidate_ids,
                actor_user_id,
            )

        for candidate in candidate_refs:
            candidate_ref = candidate["ref"]
            candidate_id = candidate_ref["id"]
            if candidate_id in refs_by_id:
                continue
            actor_user_id = candidate["actor_user_id"]
            knowledge_base = accessible_by_actor[actor_user_id].get(candidate_id)
            if not knowledge_base:
                warnings.append(
                    build_internal_knowledge_warning(knowledge_base_id=candidate_id)
                )
                continue
            try:
                refs_by_id[candidate_id] = self._build_task_knowledge_base_ref(
                    knowledge_base=knowledge_base,
                    default_ref=candidate_ref,
                    actor_user_id=actor_user_id,
                    user_name=candidate["actor_user_name"],
                    bound_at=bound_at,
                )
            except ValueError:
                warnings.append(
                    build_internal_knowledge_warning(
                        knowledge_base_id=candidate_id,
                    )
                )

        return list(refs_by_id.values()), warnings

    def _resolve_external_defaults(
        self,
        *,
        team,
        default_actor: User | None,
    ) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        candidates: list[dict[str, Any]] = []
        actor_warnings: list[dict[str, Any]] = []
        for ref in self._team_member_default_external_refs(team=team):
            ref_dict = ref.model_dump(exclude_none=True)
            if default_actor is None:
                actor_warnings.append(
                    build_external_knowledge_warning(
                        ref_dict,
                        ExternalRefValidationError(
                            "Default knowledge actor was not found",
                            reason="actor_not_found",
                        ),
                    )
                )
                continue
            candidates = merge_external_knowledge_refs(candidates, [ref_dict])

        if default_actor is None:
            return [], actor_warnings

        return filter_valid_external_knowledge_refs(
            candidates,
            binding_level="conversation",
            actor_user_id=default_actor.id,
        )

    def _team_member_default_knowledge_base_refs(
        self,
        *,
        team,
    ) -> list[dict[str, Any]]:
        knowledge_base_refs: list[dict[str, Any]] = []
        for ghost in self._iter_team_member_ghosts(team):
            ghost_crd = Ghost.model_validate(ghost.json)
            for ref in ghost_crd.spec.defaultKnowledgeBaseRefs or []:
                knowledge_base_refs.append(ref.model_dump(exclude_none=True))
        return knowledge_base_refs

    def _team_member_default_external_refs(
        self,
        *,
        team,
    ) -> list[Any]:
        refs: list[Any] = []
        for ghost in self._iter_team_member_ghosts(team):
            ghost_crd = Ghost.model_validate(ghost.json)
            for ref in ghost_crd.spec.defaultExternalKnowledgeRefs or []:
                refs.append(ref)
        return refs

    def resolve_team_owner_user(
        self,
        *,
        team,
        known_user: User | None = None,
    ) -> User | None:
        """Resolve the immutable Team owner without caller or credential fallback."""
        actor_user_id = team.user_id
        if not isinstance(actor_user_id, int):
            return None
        if known_user is not None and known_user.id == actor_user_id:
            return known_user
        actor_user = (
            self._db.query(User)
            .filter(User.id == actor_user_id, User.is_active.is_(True))
            .first()
        )
        return actor_user

    def resolve_task_owner_user(self, *, task) -> User | None:
        """Resolve the owner whose access may be shared through this Task."""
        spec = (task.json or {}).get("spec") if isinstance(task.json, dict) else {}
        team_ref = spec.get("teamRef") if isinstance(spec, dict) else {}
        actor_user_id = team_ref.get("user_id") if isinstance(team_ref, dict) else None
        if not isinstance(actor_user_id, int):
            return None
        if actor_user_id == 0:
            actor_user_id = task.user_id
        return (
            self._db.query(User)
            .filter(User.id == actor_user_id, User.is_active.is_(True))
            .first()
        )

    def _iter_team_member_ghosts(self, team) -> list:
        team_crd = Team.model_validate(team.json)
        ghosts: list[Kind] = []
        for member in team_crd.spec.members or []:
            bot_resolution = resolve_kind_reference(
                self._db,
                kind="Bot",
                ref=member.botRef,
                actor_user_id=team.user_id,
            )
            bot = bot_resolution.resource
            if bot is None or not bot.json:
                continue
            ghost_ref = Bot.model_validate(bot.json).spec.ghostRef
            ghost_resolution = resolve_kind_reference(
                self._db,
                kind="Ghost",
                ref=ghost_ref,
                actor_user_id=team.user_id,
            )
            if ghost_resolution.resource is not None:
                ghosts.append(ghost_resolution.resource)
        return ghosts

    def _build_task_knowledge_base_ref(
        self,
        *,
        knowledge_base: Kind,
        default_ref: dict[str, Any],
        actor_user_id: int,
        user_name: str,
        bound_at: str,
    ) -> dict[str, Any]:
        spec = knowledge_base.json.get("spec", {}) if knowledge_base.json else {}
        ref = {
            "id": knowledge_base.id,
            "name": spec.get("name", knowledge_base.name),
            "boundBy": user_name,
            "boundAt": bound_at,
        }
        scope_restricted = bool(
            default_ref.get("scope_restricted")
            or default_ref.get("document_ids")
            or default_ref.get("folder_ids")
        )
        if scope_restricted:
            from app.services.knowledge.folder_service import KnowledgeFolderService

            resolved_document_ids = (
                KnowledgeFolderService.resolve_document_ids_for_scope(
                    self._db,
                    knowledge_base_id=knowledge_base.id,
                    user_id=actor_user_id,
                    folder_ids=default_ref.get("folder_ids") or None,
                    document_ids=default_ref.get("document_ids") or None,
                    include_subfolders=default_ref.get("include_subfolders", True),
                )
            )
            ref.update(
                {
                    "namespace": knowledge_base.namespace or "default",
                    "scopeRestricted": True,
                    "explicitDocumentIds": resolved_document_ids or None,
                    "folderIds": default_ref.get("folder_ids") or None,
                    "includeSubfolders": default_ref.get("include_subfolders", True),
                }
            )
        return ref
