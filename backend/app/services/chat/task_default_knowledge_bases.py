# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Helpers for initializing task-level context bindings from Ghost defaults."""

from datetime import datetime
from typing import Any

from pydantic import TypeAdapter, ValidationError
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.user import User
from app.schemas.kind import (
    Bot,
    DefaultContextRef,
    Ghost,
    KnowledgeBaseDefaultRef,
    Team,
)
from app.services.chat.dingtalk_default_context import DingTalkDefaultContextResolver
from app.services.readers import KindType, kindReader

DEFAULT_CONTEXT_REF_ADAPTER = TypeAdapter(DefaultContextRef)


def _get_accessible_knowledge_base(
    db: Session, user_id: int, knowledge_base_id: int
) -> Kind | None:
    """Return the knowledge base if the current user can access it."""
    from app.services.share.knowledge_share_service import KnowledgeShareService

    return KnowledgeShareService()._get_resource(db, knowledge_base_id, user_id)


def _get_knowledge_base_display_name(knowledge_base: Kind) -> str:
    """Return the current display name for a knowledge base."""
    spec = knowledge_base.json.get("spec", {}) if knowledge_base.json else {}
    return spec.get("name", knowledge_base.name)


def _build_task_knowledge_base_ref(
    knowledge_base: Kind,
    user_name: str,
    bound_at: str,
) -> dict[str, Any]:
    """Build the task-level knowledge base ref stored in Task.spec."""
    return {
        "id": knowledge_base.id,
        "name": _get_knowledge_base_display_name(knowledge_base),
        "boundBy": user_name,
        "boundAt": bound_at,
    }


def _legacy_kb_ref_to_context_ref(ref: KnowledgeBaseDefaultRef) -> dict[str, Any]:
    return {
        "type": "knowledge_base",
        "id": ref.id,
        "name": ref.name,
    }


def _iter_team_member_default_context_refs(
    db: Session,
    team,
) -> list[DefaultContextRef]:
    """Collect default context refs from all team member Ghosts."""
    team_crd = Team.model_validate(team.json)
    context_refs: list[DefaultContextRef] = []

    for member in team_crd.spec.members or []:
        bot = kindReader.get_by_name_and_namespace(
            db,
            team.user_id,
            KindType.BOT,
            member.botRef.namespace,
            member.botRef.name,
        )
        if not bot or not bot.json:
            continue

        bot_crd = Bot.model_validate(bot.json)
        ghost = kindReader.get_by_name_and_namespace(
            db,
            team.user_id,
            KindType.GHOST,
            bot_crd.spec.ghostRef.namespace,
            bot_crd.spec.ghostRef.name,
        )
        if not ghost or not ghost.json:
            continue

        ghost_crd = Ghost.model_validate(ghost.json)
        if ghost_crd.spec.defaultContextRefs is not None:
            context_refs.extend(ghost_crd.spec.defaultContextRefs)
        else:
            for ref in ghost_crd.spec.defaultKnowledgeBaseRefs or []:
                context_refs.append(
                    DEFAULT_CONTEXT_REF_ADAPTER.validate_python(
                        _legacy_kb_ref_to_context_ref(ref)
                    )
                )

    return context_refs


def _iter_team_member_default_knowledge_base_ids(
    db: Session,
    team,
) -> list[int]:
    """Collect default knowledge base IDs from all team member Ghosts."""
    return [
        ref.id
        for ref in _iter_team_member_default_context_refs(db, team)
        if ref.type == "knowledge_base"
    ]


def _make_context_key(ref: DefaultContextRef) -> str:
    if ref.type == "knowledge_base":
        return f"knowledge_base:{ref.id}"
    if ref.type == "dingtalk_doc":
        return f"dingtalk_doc:{ref.source}:{ref.dingtalk_node_id}"
    return f"{ref.type}:{getattr(ref, 'id', '')}"


def _context_item_to_default_ref(context: Any) -> DefaultContextRef | None:
    raw = context.model_dump() if hasattr(context, "model_dump") else context
    if not isinstance(raw, dict):
        return None
    context_type = raw.get("type")
    data = raw.get("data") or {}
    if context_type == "knowledge_base":
        kb_id = data.get("knowledge_id") or data.get("id")
        if kb_id is None:
            return None
        try:
            return DEFAULT_CONTEXT_REF_ADAPTER.validate_python(
                {
                    "type": "knowledge_base",
                    "id": int(kb_id),
                    "name": data.get("name") or str(kb_id),
                    "document_count": data.get("document_count"),
                }
            )
        except (TypeError, ValueError, ValidationError):
            return None
    if context_type in {"dingtalk_doc", "external_document"}:
        source = data.get("source")
        node_id = data.get("dingtalk_node_id")
        if source not in {"docs", "wikispace"} or not node_id:
            return None
        try:
            return DEFAULT_CONTEXT_REF_ADAPTER.validate_python(
                {
                    "type": "dingtalk_doc",
                    "source": source,
                    "id": data.get("id") or f"{source}:{node_id}",
                    "dingtalk_node_id": node_id,
                    "name": data.get("name") or node_id,
                    "doc_url": data.get("doc_url") or "",
                    "node_type": data.get("node_type") or "doc",
                }
            )
        except (TypeError, ValueError, ValidationError):
            return None
    return None


def build_initial_task_context_refs(
    db: Session,
    user: User,
    team,
    explicit_contexts: list[Any] | None = None,
    default_context_mode: str = "use_defaults",
    knowledge_base_id: int | None = None,
) -> dict[str, list[dict[str, Any]]]:
    """Build task-level context refs and legacy KB refs."""
    bound_at = datetime.now().isoformat()
    explicit_refs = [
        ref
        for context in explicit_contexts or []
        if (ref := _context_item_to_default_ref(context)) is not None
    ]
    if default_context_mode == "disable_defaults":
        candidate_refs = explicit_refs
    elif default_context_mode == "override":
        candidate_refs = explicit_refs
    else:
        candidate_refs = [
            *_iter_team_member_default_context_refs(db, team),
            *explicit_refs,
        ]

    if knowledge_base_id is not None:
        kb = _get_accessible_knowledge_base(db, user.id, knowledge_base_id)
        if kb:
            candidate_refs.append(
                DEFAULT_CONTEXT_REF_ADAPTER.validate_python(
                    {
                        "type": "knowledge_base",
                        "id": kb.id,
                        "name": _get_knowledge_base_display_name(kb),
                    }
                )
            )

    seen: set[str] = set()
    context_refs: list[dict[str, Any]] = []
    context_warnings: list[dict[str, Any]] = []
    knowledge_base_refs_by_id: dict[int, dict[str, Any]] = {}
    dingtalk_resolver = DingTalkDefaultContextResolver(db)

    for ref in candidate_refs:
        key = _make_context_key(ref)
        if key in seen:
            continue
        seen.add(key)

        if ref.type == "knowledge_base":
            knowledge_base = _get_accessible_knowledge_base(db, user.id, ref.id)
            if not knowledge_base:
                continue
            kb_ref = _build_task_knowledge_base_ref(
                knowledge_base=knowledge_base,
                user_name=user.user_name,
                bound_at=bound_at,
            )
            knowledge_base_refs_by_id[knowledge_base.id] = kb_ref
            context_refs.append({"type": "knowledge_base", "data": kb_ref})
            continue

        if ref.type == "dingtalk_doc":
            context_ref, warning = dingtalk_resolver.resolve(user, ref, bound_at)
            if context_ref:
                context_refs.append(context_ref)
            if warning:
                context_warnings.append(warning)

    return {
        "context_refs": context_refs,
        "context_warnings": context_warnings,
        "knowledge_base_refs": list(knowledge_base_refs_by_id.values()),
    }


def build_initial_task_knowledge_base_refs(
    db: Session,
    user: User,
    team,
    knowledge_base_id: int | None = None,
) -> list[dict[str, Any]]:
    """Build task-level knowledge base refs from Ghost defaults plus explicit selection."""
    return build_initial_task_context_refs(
        db=db,
        user=user,
        team=team,
        knowledge_base_id=knowledge_base_id,
    )["knowledge_base_refs"]
