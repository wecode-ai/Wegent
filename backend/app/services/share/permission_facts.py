"""Action-specific matching of positive resource entity grants."""

from collections.abc import Callable, Iterable
from functools import wraps
from typing import Any, TypeVar

from sqlalchemy.orm import Session

from app.schemas.base_role import BaseRole, has_permission
from app.services.external_entity_resolver import (
    EntityFact,
    EntityMembershipUnavailable,
    entity_resolution_scope,
    get_entity_resolver,
)
from shared.telemetry.decorators import trace_sync

Result = TypeVar("Result")


def share_permission_scope(method: Callable[..., Result]) -> Callable[..., Result]:
    """Keep one public share operation's external and group facts consistent."""

    @wraps(method)
    def wrapped(service: Any, db: Session, *args: Any, **kwargs: Any) -> Result:
        with entity_resolution_scope(db):
            return method(service, db, *args, **kwargs)

    return wrapped


@trace_sync("share.entity_permission", "backend.permissions")
def check_entity_role_permission(
    db: Session,
    user_id: int,
    rows: Iterable[tuple[str, str, str | None]],
    required_role: BaseRole,
) -> bool:
    """Resolve the union of grants without requiring irrelevant memberships."""
    groups: dict[str, set[str]] = {}
    for kind, eid, role in rows:
        if kind and eid and role and has_permission(role, required_role):
            groups.setdefault(kind, set()).add(eid)
    dependencies: dict[str, frozenset[EntityFact]] = {}
    with entity_resolution_scope(db):
        for kind, ids in groups.items():
            resolver = get_entity_resolver(kind)
            if resolver is None:
                continue
            try:
                if ids.intersection(
                    resolver.match_entity_bindings(db, user_id, kind, sorted(ids))
                ):
                    return True
            except EntityMembershipUnavailable as failure:
                if ids.intersection(failure.matched_ids):
                    return True
                for eid in ids.intersection(failure.unknown_ids):
                    facts = failure.dependencies.get(eid, frozenset({(kind, eid)}))
                    dependencies[eid] = dependencies.get(eid, frozenset()) | facts
    if dependencies:
        raise EntityMembershipUnavailable(
            sorted(dependencies), [], dependencies=dependencies
        )
    return False
