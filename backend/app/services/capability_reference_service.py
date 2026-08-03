# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Reference-backed access to shared capability Kinds."""

from datetime import datetime

from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.namespace import Namespace
from app.models.resource_member import MemberStatus, ResourceMember
from app.schemas.base_role import BaseRole

REFERENCE_KINDS = {"Model", "Shell", "Retriever"}


def ensure_capability_reference(
    db: Session,
    *,
    source: Kind,
    target_namespace: str,
    user_id: int,
) -> tuple[ResourceMember, bool]:
    """Create or restore a personal/group reference to a capability Kind."""
    if source.user_id == 0:
        raise ValueError("System capabilities are globally available")

    entity_type = "user"
    entity_id = str(user_id)
    entity_display_name = ""
    if target_namespace != "default":
        namespace = (
            db.query(Namespace)
            .filter(
                Namespace.name == target_namespace,
                Namespace.is_active.is_(True),
            )
            .first()
        )
        if namespace is None:
            raise ValueError("Target group not found")
        entity_type = "namespace"
        entity_id = str(namespace.id)
        entity_display_name = namespace.display_name or namespace.name

    member = (
        db.query(ResourceMember)
        .filter(
            ResourceMember.resource_type == source.kind,
            ResourceMember.resource_id == source.id,
            ResourceMember.entity_type == entity_type,
            ResourceMember.entity_id == entity_id,
        )
        .first()
    )
    if member is not None:
        was_active = member.status == MemberStatus.APPROVED.value
        member.status = MemberStatus.APPROVED.value
        member.role = BaseRole.Reporter.value
        member.reviewed_by_user_id = user_id
        member.reviewed_at = datetime.utcnow()
        member.updated_at = datetime.utcnow()
        return member, was_active

    member = ResourceMember.create(
        resource_type=source.kind,
        resource_id=source.id,
        entity_type=entity_type,
        entity_id=entity_id,
        entity_display_name=entity_display_name,
        role=BaseRole.Reporter.value,
        status=MemberStatus.APPROVED.value,
        invited_by_user_id=user_id,
        reviewed_by_user_id=user_id,
        reviewed_at=datetime.utcnow(),
    )
    db.add(member)
    db.flush()
    return member, False


def list_referenced_capabilities(
    db: Session,
    *,
    kind: str,
    user_id: int,
    namespace: str,
) -> list[Kind]:
    """Return source Kinds referenced into the requested visible namespace."""
    if kind not in REFERENCE_KINDS:
        return []
    entity_type = "user"
    entity_id = str(user_id)
    if namespace != "default":
        target = (
            db.query(Namespace)
            .filter(
                Namespace.name == namespace,
                Namespace.is_active.is_(True),
            )
            .first()
        )
        if target is None:
            return []
        entity_type = "namespace"
        entity_id = str(target.id)

    source_ids = [
        row.resource_id
        for row in db.query(ResourceMember)
        .filter(
            ResourceMember.resource_type == kind,
            ResourceMember.entity_type == entity_type,
            ResourceMember.entity_id == entity_id,
            ResourceMember.status == MemberStatus.APPROVED.value,
        )
        .all()
    ]
    if not source_ids:
        return []
    return (
        db.query(Kind)
        .filter(
            Kind.id.in_(source_ids),
            Kind.kind == kind,
            Kind.user_id != 0,
            Kind.is_active.is_(True),
        )
        .all()
    )


def get_referenced_capability(
    db: Session,
    *,
    kind: str,
    name: str,
    user_id: int,
    namespace: str,
) -> Kind | None:
    """Resolve a referenced source Kind by its target-visible name."""
    return next(
        (
            source
            for source in list_referenced_capabilities(
                db,
                kind=kind,
                user_id=user_id,
                namespace=namespace,
            )
            if source.name == name
        ),
        None,
    )


def has_personal_capability_reference(
    db: Session, *, source: Kind, user_id: int
) -> bool:
    return (
        db.query(ResourceMember.id)
        .filter(
            ResourceMember.resource_type == source.kind,
            ResourceMember.resource_id == source.id,
            ResourceMember.entity_type == "user",
            ResourceMember.entity_id == str(user_id),
            ResourceMember.status == MemberStatus.APPROVED.value,
        )
        .first()
        is not None
    )


def sync_group_capability_references(
    db: Session,
    *,
    source: Kind,
    group_names: list[str],
    user_id: int,
) -> None:
    """Replace direct group references for a shared capability."""
    if source.user_id == 0:
        db.query(ResourceMember).filter(
            ResourceMember.resource_type == source.kind,
            ResourceMember.resource_id == source.id,
            ResourceMember.entity_type == "namespace",
        ).delete(synchronize_session=False)
        db.flush()
        return

    namespaces = (
        db.query(Namespace)
        .filter(
            Namespace.name.in_(group_names),
            Namespace.is_active.is_(True),
        )
        .all()
        if group_names
        else []
    )
    namespace_by_name = {namespace.name: namespace for namespace in namespaces}
    missing_names = set(group_names) - namespace_by_name.keys()
    if missing_names:
        raise ValueError("Target group not found")

    desired_ids = {str(namespace_by_name[group_name].id) for group_name in group_names}
    current_members = (
        db.query(ResourceMember)
        .filter(
            ResourceMember.resource_type == source.kind,
            ResourceMember.resource_id == source.id,
            ResourceMember.entity_type == "namespace",
        )
        .all()
    )
    for member in current_members:
        if member.entity_id not in desired_ids:
            db.delete(member)
    for group_name in group_names:
        ensure_capability_reference(
            db,
            source=source,
            target_namespace=group_name,
            user_id=user_id,
        )
    db.flush()
