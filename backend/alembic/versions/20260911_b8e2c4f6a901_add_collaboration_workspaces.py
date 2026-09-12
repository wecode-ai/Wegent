# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""store collaboration workspaces in existing resource tables

Revision ID: b8e2c4f6a901
Revises: 580031eb7ddc
Create Date: 2026-09-11
"""

import json
import uuid

import sqlalchemy as sa

from alembic import op

revision = "b8e2c4f6a901"
down_revision = "580031eb7ddc"
branch_labels = None
depends_on = None

MIGRATION_MARKER = "collaboration-storage-b8e2c4f6a901"


def _metadata(value: object) -> dict[str, object]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value:
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


def _workspace_payload(name: str, public_id: str) -> dict[str, object]:
    return {
        "apiVersion": "agent.wecode.io/v1",
        "kind": "CollaborationWorkspace",
        "metadata": {
            "name": name,
            "namespace": "default",
            "publicId": public_id,
            "migrationSource": MIGRATION_MARKER,
        },
        "spec": {"description": "", "isDefault": True},
        "status": {"state": "active", "version": 1},
    }


def _insert_member(
    connection: sa.Connection,
    members: sa.TableClause,
    *,
    resource_type: str,
    resource_id: int,
    entity_type: str,
    entity_id: str,
    user_id: int,
    role: str,
    invited_by_user_id: int = 0,
) -> None:
    exists = connection.execute(
        sa.select(members.c.resource_id).where(
            members.c.resource_type == resource_type,
            members.c.resource_id == resource_id,
            members.c.entity_type == entity_type,
            members.c.entity_id == entity_id,
        )
    ).first()
    if exists is not None:
        return
    values = {
        "resource_type": resource_type,
        "resource_id": resource_id,
        "entity_type": entity_type,
        "entity_id": entity_id,
        "user_id": user_id,
        "role": role,
        "status": "approved",
    }
    if "invited_by_user_id" in members.c:
        values["invited_by_user_id"] = invited_by_user_id
    connection.execute(members.insert().values(**values))


def _create_workspaces(
    connection: sa.Connection,
    kinds: sa.TableClause,
    members: sa.TableClause,
    projects: list[sa.Row],
) -> tuple[dict[int, int], dict[str, int]]:
    workspace_by_owner: dict[int, int] = {}
    workspace_by_project: dict[str, int] = {}
    for project in projects:
        owner_id = int(project.created_by_user_id or 0)
        workspace_id = workspace_by_owner.get(owner_id)
        if workspace_id is None:
            public_id = str(uuid.uuid4())
            result = connection.execute(
                kinds.insert().values(
                    user_id=owner_id,
                    kind="CollaborationWorkspace",
                    name="默认协作空间",
                    namespace="default",
                    json=_workspace_payload("默认协作空间", public_id),
                    is_active=True,
                )
            )
            workspace_id = int(result.inserted_primary_key[0])
            workspace_by_owner[owner_id] = workspace_id
            if owner_id:
                _insert_member(
                    connection,
                    members,
                    resource_type="Workspace",
                    resource_id=workspace_id,
                    entity_type="user",
                    entity_id=str(owner_id),
                    user_id=owner_id,
                    role="Owner",
                )
        project_id = str(project.id)
        workspace_by_project[project_id] = workspace_id
        _insert_member(
            connection,
            members,
            resource_type="CloudProject",
            resource_id=int(project_id),
            entity_type="workspace",
            entity_id=str(workspace_id),
            user_id=0,
            role="Owner",
            invited_by_user_id=owner_id,
        )
    return workspace_by_owner, workspace_by_project


def _copy_project_members(
    connection: sa.Connection,
    members: sa.TableClause,
    workspace_by_project: dict[str, int],
) -> None:
    rows = connection.execute(
        sa.select(
            members.c.resource_id,
            members.c.entity_id,
            members.c.user_id,
            members.c.role,
        ).where(
            members.c.resource_type == "CloudProject",
            members.c.entity_type == "user",
            members.c.status == "approved",
        )
    )
    for row in rows:
        workspace_id = workspace_by_project.get(str(row.resource_id))
        if workspace_id is None:
            continue
        _insert_member(
            connection,
            members,
            resource_type="Workspace",
            resource_id=workspace_id,
            entity_type="user",
            entity_id=str(row.entity_id),
            user_id=int(row.user_id or row.entity_id),
            role=("Reporter" if row.role == "RestrictedAnalyst" else str(row.role)),
        )


def _grant_agent_resources(
    connection: sa.Connection,
    loop_items: sa.TableClause,
    kinds: sa.TableClause,
    members: sa.TableClause,
    workspace_by_project: dict[str, int],
) -> None:
    devices = {
        (int(row.user_id or 0), str(row.name)): int(row.id)
        for row in connection.execute(
            sa.select(kinds.c.id, kinds.c.user_id, kinds.c.name).where(
                kinds.c.kind == "Device",
                kinds.c.is_active.is_(True),
            )
        )
    }
    agents = connection.execute(
        sa.select(
            loop_items.c.cloud_project_id,
            loop_items.c.created_by_user_id,
            loop_items.c.device_id,
            loop_items.c.metadata,
        ).where(loop_items.c.resource_type == "chat_agent")
    )
    for agent in agents:
        workspace_id = workspace_by_project.get(str(agent.cloud_project_id))
        if workspace_id is None:
            continue
        owner_id = int(agent.created_by_user_id or 0)
        team_value = _metadata(agent.metadata).get("wegent_team_id")
        try:
            team_id = int(team_value) if team_value is not None else None
        except (TypeError, ValueError):
            team_id = None
        if team_id:
            _insert_member(
                connection,
                members,
                resource_type="Team",
                resource_id=team_id,
                entity_type="workspace",
                entity_id=str(workspace_id),
                user_id=0,
                role="Developer",
                invited_by_user_id=owner_id,
            )
        if agent.device_id:
            device_id = devices.get((owner_id, str(agent.device_id)))
            if device_id:
                _insert_member(
                    connection,
                    members,
                    resource_type="Device",
                    resource_id=device_id,
                    entity_type="workspace",
                    entity_id=str(workspace_id),
                    user_id=0,
                    role="Developer",
                    invited_by_user_id=owner_id,
                )


def _assignment_target(item: sa.Row) -> tuple[str, str] | None:
    if item.assignee_agent_id:
        return "agent", str(item.assignee_agent_id)
    if item.assignee_team_id:
        return "agent", str(item.assignee_team_id)
    if item.assignee_user_id:
        return "human", str(item.assignee_user_id)
    return None


def _create_assignment_events(
    connection: sa.Connection,
    loop_items: sa.TableClause,
) -> None:
    tasks = connection.execute(
        sa.select(
            loop_items.c.id,
            loop_items.c.cloud_project_id,
            loop_items.c.created_by_user_id,
            loop_items.c.assignee_user_id,
            loop_items.c.assignee_agent_id,
            loop_items.c.assignee_team_id,
        ).where(loop_items.c.resource_type == "task")
    )
    for item in tasks:
        target = _assignment_target(item)
        if target is None:
            continue
        event_id = f"assignment-{uuid.uuid4().hex}"
        values: dict[str, object] = {
            "id": event_id,
            "resource_type": "comment",
            "cloud_project_id": str(item.cloud_project_id),
            "loop_item_id": str(item.id),
            "description": "",
            "created_by_user_id": int(item.created_by_user_id or 0),
            "updated_by_user_id": int(item.created_by_user_id or 0),
            "status": "active",
            "metadata": {
                "event_type": "assignment",
                "action": "assign",
                "target_type": target[0],
                "target_id": target[1],
                "target_name": "",
                "workflow_step": "",
                "notify": False,
                "trigger": "manual",
                "migration_source": MIGRATION_MARKER,
            },
        }
        if "assignee_agent_id" in loop_items.c:
            values["assignee_agent_id"] = ""
        connection.execute(loop_items.insert().values(**values))


def upgrade() -> None:
    connection = op.get_bind()
    metadata = sa.MetaData()
    kinds = sa.Table("kinds", metadata, autoload_with=connection)
    members = sa.Table("resource_members", metadata, autoload_with=connection)
    loop_items = sa.Table("loop_items", metadata, autoload_with=connection)
    projects = list(
        connection.execute(
            sa.select(
                loop_items.c.id,
                loop_items.c.created_by_user_id,
            ).where(loop_items.c.resource_type == "project")
        )
    )
    _, workspace_by_project = _create_workspaces(connection, kinds, members, projects)
    _copy_project_members(connection, members, workspace_by_project)
    _grant_agent_resources(
        connection,
        loop_items,
        kinds,
        members,
        workspace_by_project,
    )
    _create_assignment_events(connection, loop_items)


def downgrade() -> None:
    connection = op.get_bind()
    metadata = sa.MetaData()
    kinds = sa.Table("kinds", metadata, autoload_with=connection)
    members = sa.Table("resource_members", metadata, autoload_with=connection)
    loop_items = sa.Table("loop_items", metadata, autoload_with=connection)

    generated_workspace_ids = []
    for row in connection.execute(
        sa.select(kinds.c.id, kinds.c.json).where(
            kinds.c.kind == "CollaborationWorkspace"
        )
    ):
        metadata_value = _metadata(row.json).get("metadata")
        metadata_value = metadata_value if isinstance(metadata_value, dict) else {}
        if metadata_value.get("migrationSource") == MIGRATION_MARKER:
            generated_workspace_ids.append(int(row.id))

    generated_comment_ids = []
    for row in connection.execute(
        sa.select(loop_items.c.id, loop_items.c.metadata).where(
            loop_items.c.resource_type == "comment"
        )
    ):
        if _metadata(row.metadata).get("migration_source") == MIGRATION_MARKER:
            generated_comment_ids.append(str(row.id))

    if generated_comment_ids:
        connection.execute(
            loop_items.delete().where(loop_items.c.id.in_(generated_comment_ids))
        )
    if generated_workspace_ids:
        workspace_strings = [str(value) for value in generated_workspace_ids]
        connection.execute(
            members.delete().where(
                sa.or_(
                    sa.and_(
                        members.c.resource_type == "Workspace",
                        members.c.resource_id.in_(generated_workspace_ids),
                    ),
                    sa.and_(
                        members.c.entity_type == "workspace",
                        members.c.entity_id.in_(workspace_strings),
                    ),
                )
            )
        )
        connection.execute(
            kinds.delete().where(kinds.c.id.in_(generated_workspace_ids))
        )
