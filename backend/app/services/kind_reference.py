# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Stable Kind reference resolution with explicit legacy compatibility."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping

from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.schemas.namespace import GroupRole
from app.services.group_permission import check_group_permission


@dataclass(frozen=True)
class KindReferenceResolution:
    """Result of resolving one Kind reference."""

    resource: Kind | None
    used_legacy_lookup: bool = False
    reason: str | None = None


def resolve_kind_reference(
    db: Session,
    *,
    kind: str,
    ref: Mapping[str, Any] | Any,
    actor_user_id: int,
) -> KindReferenceResolution:
    """Resolve a Kind ref by ID, falling back only for refs without an ID.

    ID-backed refs are strict: kind, active state, access, name, and namespace
    must all still match. A stale or mismatched ID never falls back to another
    resource with the same legacy coordinates.
    """
    ref_id = _ref_value(ref, "id")
    name = _ref_value(ref, "name")
    namespace = _ref_value(ref, "namespace") or "default"
    if ref_id is not None:
        resource = db.query(Kind).filter(Kind.id == ref_id).first()
        reason = _validate_resolved_resource(
            db,
            resource,
            kind=kind,
            name=name,
            namespace=namespace,
            actor_user_id=actor_user_id,
        )
        return KindReferenceResolution(
            resource=None if reason else resource,
            reason=reason,
        )

    resource = _resolve_legacy_reference(
        db,
        kind=kind,
        name=name,
        namespace=namespace,
        actor_user_id=actor_user_id,
    )
    return KindReferenceResolution(
        resource=resource,
        used_legacy_lookup=resource is not None,
        reason=None if resource is not None else "not_found",
    )


def legacy_reference_candidates(
    db: Session,
    *,
    kind: str,
    name: str,
    namespace: str,
    actor_user_id: int,
) -> list[Kind]:
    """Return all safe migration candidates without choosing among duplicates."""
    query = db.query(Kind).filter(
        Kind.kind == kind,
        Kind.name == name,
        Kind.namespace == namespace,
        Kind.is_active.is_(True),
    )
    rows = query.all()
    return [row for row in rows if _has_reference_access(db, row, actor_user_id)]


def _resolve_legacy_reference(
    db: Session,
    *,
    kind: str,
    name: str | None,
    namespace: str,
    actor_user_id: int,
) -> Kind | None:
    if not name:
        return None
    query = db.query(Kind).filter(
        Kind.kind == kind,
        Kind.name == name,
        Kind.namespace == namespace,
        Kind.is_active.is_(True),
    )
    if namespace == "default":
        owned = query.filter(Kind.user_id == actor_user_id).first()
        if owned is not None:
            return owned
        return query.filter(Kind.user_id == 0).first()
    owned = query.filter(Kind.user_id == actor_user_id).first()
    if owned is not None:
        return owned
    if not check_group_permission(db, actor_user_id, namespace, GroupRole.Reporter):
        return None
    return query.first()


def _validate_resolved_resource(
    db: Session,
    resource: Kind | None,
    *,
    kind: str,
    name: str | None,
    namespace: str,
    actor_user_id: int,
) -> str | None:
    if resource is None:
        return "not_found"
    if resource.kind != kind:
        return "kind_mismatch"
    if not resource.is_active:
        return "inactive"
    if name and resource.name != name:
        return "name_mismatch"
    if resource.namespace != namespace:
        return "namespace_mismatch"
    if not _has_reference_access(db, resource, actor_user_id):
        return "permission_denied"
    return None


def _has_reference_access(db: Session, resource: Kind, actor_user_id: int) -> bool:
    # Team access has richer semantics than ordinary Kind resources: direct
    # shares and namespace grants are both valid references.  Keep this here
    # so ID-backed Task references are checked with the same policy as runtime
    # Team reads rather than silently narrowing shared Teams to their owner.
    if resource.kind == "Team":
        from app.schemas.share import MemberRole
        from app.services.share.team_share_service import team_share_service

        if team_share_service.get_resource(db, resource.id, actor_user_id):
            return True
        if resource.namespace != "default":
            return team_share_service.check_permission(
                db, resource.id, actor_user_id, MemberRole.Reporter
            )
        return False

    namespace = resource.namespace or "default"
    if namespace == "default":
        return resource.user_id in {actor_user_id, 0}
    if resource.user_id == actor_user_id:
        return True
    return check_group_permission(db, actor_user_id, namespace, GroupRole.Reporter)


def _ref_value(ref: Mapping[str, Any] | Any, key: str) -> Any:
    if isinstance(ref, Mapping):
        return ref.get(key)
    return getattr(ref, key, None)
