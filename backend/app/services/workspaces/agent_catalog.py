# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Request-owned batched data for the authorized Workspace Agent catalog."""

from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.resource_member import ResourceMember
from app.models.share_link import ResourceType
from app.models.user import User
from app.schemas.base_role import has_permission
from app.schemas.namespace import GroupRole
from app.services.execution.readiness_context import TeamReadinessContext
from app.services.group_permission import get_effective_roles_in_groups
from app.services.workspaces.resource_mapping import (
    agent_values,
    owner_identity,
    workspace_resource_grants,
)
from shared.telemetry.decorators import trace_sync


@trace_sync("workspace.agent_catalog", tracer_name="backend")
def map_agent_catalog(
    db: Session,
    rows: list[tuple[ResourceMember, Kind]],
    workspace_id: int,
    user_id: int,
    *,
    include_readiness: bool,
) -> list[dict[str, object]]:
    """Discover Agents without executing their dependency graph; retain legacy preflight."""
    if not rows:
        return []
    identities = {owner_identity(grant, team) for grant, team in rows}
    names = _owner_names(db, identities)
    namespaces = list(
        {team.namespace for _, team in rows if team.namespace != "default"}
    )
    roles = get_effective_roles_in_groups(db, user_id, namespaces)
    environments = [
        str(grant.resource_id)
        for grant in workspace_resource_grants(
            db, workspace_id, ResourceType.DEVICE.value
        )
    ]
    teams = [team for _, team in rows]
    readiness = TeamReadinessContext(db, teams, user_id) if include_readiness else None
    return [
        agent_values(
            db,
            grant=grant,
            team=team,
            execution_user_id=user_id,
            include_readiness=include_readiness,
            owner=(
                kind,
                owner_id,
                names.get((kind, owner_id), ""),
                int(owner_id) if kind == "user" else None,
            ),
            environment_ids=environments,
            editable=(
                team.user_id == user_id
                if team.namespace == "default"
                else team.namespace in roles
                and has_permission(roles[team.namespace], GroupRole.Developer)
            ),
            readiness=readiness,
        )
        for grant, team in rows
        for kind, owner_id in [owner_identity(grant, team)]
    ]


def _owner_names(
    db: Session, identities: set[tuple[str, str]]
) -> dict[tuple[str, str], str]:
    """Fetch only the names needed by catalog rows, once per owner type."""
    names: dict[tuple[str, str], str] = {}
    for kind, model, column in [
        ("user", User, User.user_name),
        ("workspace", Kind, Kind.name),
    ]:
        ids = {
            int(owner_id) for owner_kind, owner_id in identities if owner_kind == kind
        }
        if ids:
            names.update(
                {
                    (kind, str(row_id)): name
                    for row_id, name in db.query(model.id, column)
                    .filter(model.id.in_(ids))
                    .all()
                }
            )
    return names
