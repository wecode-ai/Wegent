"""Atomic resource grants retaining their unique identity and audit history."""

from contextlib import contextmanager
from typing import Iterator

from sqlalchemy import func
from sqlalchemy.dialects.mysql import insert as mysql_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session

from app.models.resource_member import MemberStatus, ResourceMember
from app.schemas.base_role import BaseRole


def ensure_resource_member_grant(
    db: Session,
    *,
    resource_type: str,
    resource_id: int,
    entity_type: str,
    entity_id: str,
    added_by_user_id: int,
    role: BaseRole,
) -> ResourceMember:
    identity = dict(
        resource_type=resource_type,
        resource_id=resource_id,
        entity_type=entity_type,
        entity_id=entity_id,
    )
    updates = dict(
        role=role.value,
        status=MemberStatus.APPROVED.value,
        invited_by_user_id=added_by_user_id,
        updated_at=func.now(),
    )
    return _write_grant(db, identity, updates, overwrite=True)


def _write_grant(
    db: Session, identity: dict, updates: dict, *, overwrite: bool
) -> ResourceMember:
    # Insert before locking: missing-key range locks can deadlock independent grants.
    db.flush()
    if db.get_bind().dialect.name == "mysql":
        statement = mysql_insert(ResourceMember).values(**identity, **updates)
        statement = statement.on_duplicate_key_update(
            **(updates if overwrite else {"id": ResourceMember.id})
        )
    else:
        statement = sqlite_insert(ResourceMember).values(**identity, **updates)
        statement = (
            statement.on_conflict_do_update(index_elements=list(identity), set_=updates)
            if overwrite
            else statement.on_conflict_do_nothing(index_elements=list(identity))
        )
    db.execute(statement)
    return (
        db.query(ResourceMember)
        .filter_by(**identity)
        .with_for_update()
        .populate_existing()
        .one()
    )


@contextmanager
def resource_member_grant_candidate(
    db: Session,
    *,
    resource_type: str,
    resource_id: int,
    entity_type: str,
    entity_id: str,
    added_by_user_id: int,
    role: BaseRole,
) -> Iterator[ResourceMember]:
    """Lock a current existing consent or roll back an unapproved candidate on refusal."""
    identity = dict(
        resource_type=resource_type,
        resource_id=resource_id,
        entity_type=entity_type,
        entity_id=entity_id,
    )
    updates = dict(
        role=role.value,
        status=MemberStatus.PENDING.value,
        invited_by_user_id=added_by_user_id,
        updated_at=func.now(),
    )
    with db.begin_nested():
        yield _write_grant(db, identity, updates, overwrite=False)
