"""Migrate Wework execution settings into Runtime loop items.

Revision ID: e58ee381a7c2
Revises: d47dd270f4b6
"""

from __future__ import annotations

import json
import uuid
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "e58ee381a7c2"
down_revision: str | Sequence[str] | None = "d47dd270f4b6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

loop_items = sa.table(
    "loop_items",
    sa.column("id", sa.String),
    sa.column("resource_type", sa.String),
    sa.column("cloud_project_id", sa.String),
    sa.column("parent_id", sa.String),
    sa.column("name", sa.String),
    sa.column("title", sa.String),
    sa.column("description", sa.Text),
    sa.column("created_by_user_id", sa.Integer),
    sa.column("updated_by_user_id", sa.Integer),
    sa.column("user_id", sa.Integer),
    sa.column("device_id", sa.String),
    sa.column("local_project_id", sa.Integer),
    sa.column("assignee_agent_id", sa.String),
    sa.column("status", sa.String),
    sa.column("is_default", sa.Boolean),
    sa.column("source_task_snapshot", sa.JSON),
    sa.column("metadata", sa.JSON),
    sa.column("version", sa.Integer),
)

loop_item_executions = sa.table(
    "loop_item_executions",
    sa.column("id", sa.BigInteger),
    sa.column("agent_id", sa.String),
    sa.column("team_id", sa.Integer),
    sa.column("automation_run_id", sa.String),
    sa.column("execution_environment", sa.String),
    sa.column("execution_device_id", sa.String),
    sa.column("status", sa.String),
    sa.column("execution_note", sa.String),
    sa.column("execution_payload", sa.Text),
    sa.column("version", sa.Integer),
)


def _profile_values(
    row: sa.RowMapping,
    metadata: dict,
    label: str,
    *,
    device_id: str | None = None,
) -> dict:
    profile_id = str(uuid.uuid4())
    return {
        "id": profile_id,
        "resource_type": "runtime_profile",
        "name": label,
        "title": label,
        "description": "",
        "created_by_user_id": row["created_by_user_id"],
        "updated_by_user_id": row["created_by_user_id"],
        "user_id": row["created_by_user_id"],
        "device_id": device_id or row["device_id"],
        "status": "active",
        "is_default": False,
        "source_task_snapshot": {},
        "metadata": {
            "execution_environment": metadata.get("execution_environment") or "local",
            "model": metadata.get("model"),
            "model_type": None,
            "model_options": {},
            "workspace_policy": "project",
            "catalog_visibility": "internal",
            "migrated_from": {
                "resource_type": row["resource_type"],
                "resource_id": row["id"],
            },
        },
        "version": 1,
    }


def upgrade() -> None:
    connection = op.get_bind()
    rows = (
        connection.execute(
            sa.select(
                loop_items.c.id,
                loop_items.c.resource_type,
                loop_items.c.created_by_user_id,
                loop_items.c.cloud_project_id,
                loop_items.c.device_id,
                loop_items.c.local_project_id,
                loop_items.c.assignee_agent_id,
                loop_items.c.name,
                loop_items.c.title,
                loop_items.c.metadata,
            ).where(loop_items.c.resource_type.in_(["chat_agent", "automation_rule"]))
        )
        .mappings()
        .all()
    )
    agent_profiles: dict[str, dict] = {}
    automation_profiles: dict[str, dict] = {}
    for row in rows:
        metadata = dict(row["metadata"] or {})
        if row["resource_type"] == "chat_agent":
            model = metadata.get("model")
            if row["device_id"] and model:
                profile = _profile_values(
                    row,
                    metadata,
                    f"{row['title'] or row['name'] or 'Robot'} Runtime",
                )
                connection.execute(loop_items.insert().values(**profile))
                metadata["default_runtime_profile_id"] = profile["id"]
                agent_profiles[str(row["id"])] = profile
                if row["cloud_project_id"] and row["local_project_id"]:
                    existing_binding = connection.execute(
                        sa.select(loop_items.c.id).where(
                            loop_items.c.resource_type == "local_binding",
                            loop_items.c.cloud_project_id == row["cloud_project_id"],
                            loop_items.c.user_id == row["created_by_user_id"],
                            loop_items.c.device_id == row["device_id"],
                            loop_items.c.local_project_id == row["local_project_id"],
                        )
                    ).first()
                    if existing_binding is None:
                        binding_id = str(uuid.uuid4())
                        connection.execute(
                            loop_items.insert().values(
                                id=binding_id,
                                resource_type="local_binding",
                                cloud_project_id=row["cloud_project_id"],
                                name="Migrated robot workspace",
                                title="Migrated robot workspace",
                                description="",
                                created_by_user_id=row["created_by_user_id"],
                                updated_by_user_id=row["created_by_user_id"],
                                user_id=row["created_by_user_id"],
                                device_id=row["device_id"],
                                local_project_id=row["local_project_id"],
                                status="active",
                                is_default=False,
                                source_task_snapshot={},
                                metadata={
                                    "migrated_from": {
                                        "resource_type": "chat_agent",
                                        "resource_id": row["id"],
                                    }
                                },
                                version=1,
                            )
                        )
            metadata.pop("model", None)
            metadata.pop("execution_environment", None)
            connection.execute(
                loop_items.update()
                .where(loop_items.c.id == row["id"])
                .values(device_id="", local_project_id=0, metadata=metadata)
            )
            continue

        assignment_mode = metadata.pop("assignment_mode", "manual")
        manager_type = metadata.pop("manager_type", None)
        role_source = metadata.pop("role_source", "agent")
        runtime_source = metadata.pop("runtime_source", None)
        runtime_profile_id = metadata.pop("runtime_profile_id", None)
        runtime_user_id = metadata.pop("runtime_user_id", None)
        manager_device_id = metadata.get("execution_device_id")
        if manager_type == "custom" and manager_device_id and metadata.get("model"):
            profile = _profile_values(
                row,
                metadata,
                f"{row['title'] or row['name'] or 'Automation'} Runtime",
                device_id=str(manager_device_id),
            )
            connection.execute(loop_items.insert().values(**profile))
            runtime_source = "fixed_profile"
            runtime_profile_id = profile["id"]
            automation_profiles[str(row["id"])] = profile
        metadata["action"] = "execute" if assignment_mode == "manual" else "ai_assign"
        metadata["role"] = {
            "source": role_source,
            "agent_id": row["assignee_agent_id"] or None,
        }
        metadata["runtime"] = {
            "source": runtime_source or "agent_default",
            "runtime_profile_id": runtime_profile_id,
            "user_id": runtime_user_id,
        }
        if manager_type:
            metadata["manager"] = {
                "type": manager_type,
                "wegent_team_id": metadata.pop("wegent_team_id", None),
            }
        metadata.pop("model", None)
        metadata.pop("execution_environment", None)
        metadata.pop("execution_device_id", None)
        connection.execute(
            loop_items.update()
            .where(loop_items.c.id == row["id"])
            .values(device_id="", metadata=metadata)
        )

    run_rules = {
        str(row["id"]): str(row["parent_id"])
        for row in connection.execute(
            sa.select(loop_items.c.id, loop_items.c.parent_id).where(
                loop_items.c.resource_type == "automation_run"
            )
        ).mappings()
        if row["parent_id"]
    }
    executions = (
        connection.execute(
            sa.select(
                loop_item_executions.c.id,
                loop_item_executions.c.agent_id,
                loop_item_executions.c.team_id,
                loop_item_executions.c.automation_run_id,
                loop_item_executions.c.status,
                loop_item_executions.c.version,
            ).where(
                loop_item_executions.c.status.in_(
                    ["pending_approval", "waiting_runtime", "queued"]
                )
            )
        )
        .mappings()
        .all()
    )
    for execution in executions:
        if execution["team_id"]:
            continue
        profile = agent_profiles.get(str(execution["agent_id"] or ""))
        runtime_source = "agent_default"
        if profile is None:
            rule_id = run_rules.get(str(execution["automation_run_id"] or ""))
            profile = automation_profiles.get(rule_id or "")
            runtime_source = "fixed_profile" if profile else "selected"
        selection = {
            "runtime_profile_id": profile["id"] if profile else None,
            "runtime_profile_version": profile["version"] if profile else None,
            "runtime_source": runtime_source,
            "workspace_policy": (
                profile["metadata"]["workspace_policy"] if profile else "project"
            ),
        }
        values = {
            "execution_payload": json.dumps(
                selection, ensure_ascii=False, separators=(",", ":")
            ),
            "version": int(execution["version"] or 1) + 1,
        }
        if profile:
            values.update(
                execution_environment=profile["metadata"]["execution_environment"],
                execution_device_id=profile["device_id"] or "",
            )
        elif execution["status"] != "pending_approval":
            values.update(
                status="waiting_runtime",
                execution_environment="",
                execution_device_id="",
                execution_note=(
                    "Select a device and model before this execution can start"
                ),
            )
        connection.execute(
            loop_item_executions.update()
            .where(loop_item_executions.c.id == execution["id"])
            .values(**values)
        )


def downgrade() -> None:
    connection = op.get_bind()
    local_bindings = (
        connection.execute(
            sa.select(
                loop_items.c.id,
                loop_items.c.local_project_id,
                loop_items.c.metadata,
            ).where(loop_items.c.resource_type == "local_binding")
        )
        .mappings()
        .all()
    )
    migrated_local_bindings = {
        str(row["metadata"]["migrated_from"]["resource_id"]): row
        for row in local_bindings
        if isinstance(row["metadata"], dict)
        and isinstance(row["metadata"].get("migrated_from"), dict)
        and row["metadata"]["migrated_from"].get("resource_type") == "chat_agent"
    }
    profiles = (
        connection.execute(
            sa.select(
                loop_items.c.id,
                loop_items.c.device_id,
                loop_items.c.metadata,
            ).where(loop_items.c.resource_type == "runtime_profile")
        )
        .mappings()
        .all()
    )
    migrated_profiles = {
        str(row["id"]): row
        for row in profiles
        if isinstance(row["metadata"], dict)
        and isinstance(row["metadata"].get("migrated_from"), dict)
    }
    for profile in migrated_profiles.values():
        metadata = dict(profile["metadata"])
        source = metadata["migrated_from"]
        source_id = source.get("resource_id")
        source_type = source.get("resource_type")
        if not source_id or source_type not in {"chat_agent", "automation_rule"}:
            continue
        source_row = (
            connection.execute(
                sa.select(loop_items.c.metadata).where(loop_items.c.id == source_id)
            )
            .mappings()
            .first()
        )
        if source_row is None:
            continue
        source_metadata = dict(source_row["metadata"] or {})
        source_metadata["model"] = metadata.get("model")
        source_metadata["execution_environment"] = metadata.get("execution_environment")
        values = {
            "device_id": profile["device_id"],
            "metadata": source_metadata,
        }
        if source_type == "chat_agent":
            source_metadata.pop("default_runtime_profile_id", None)
            binding = migrated_local_bindings.get(str(source_id))
            values["local_project_id"] = (
                binding["local_project_id"] if binding is not None else None
            )
        else:
            source_metadata["execution_device_id"] = profile["device_id"]
        connection.execute(
            loop_items.update().where(loop_items.c.id == source_id).values(**values)
        )

    rows = connection.execute(
        sa.select(loop_items.c.id, loop_items.c.metadata).where(
            loop_items.c.resource_type == "automation_rule"
        )
    ).mappings()
    for row in rows:
        metadata = dict(row["metadata"] or {})
        action = metadata.pop("action", None)
        role = metadata.pop("role", {})
        runtime = metadata.pop("runtime", {})
        manager = metadata.pop("manager", {})
        metadata["assignment_mode"] = (
            "ai_managed" if action == "ai_assign" else "manual"
        )
        metadata["role_source"] = role.get("source", "agent")
        metadata["runtime_source"] = runtime.get("source", "agent_default")
        metadata["runtime_profile_id"] = runtime.get("runtime_profile_id")
        metadata["runtime_user_id"] = runtime.get("user_id")
        if manager:
            metadata["manager_type"] = manager.get("type")
            metadata["wegent_team_id"] = manager.get("wegent_team_id")
        profile = migrated_profiles.get(str(runtime.get("runtime_profile_id") or ""))
        if profile is not None:
            profile_metadata = dict(profile["metadata"])
            metadata["model"] = profile_metadata.get("model")
            metadata["execution_environment"] = profile_metadata.get(
                "execution_environment"
            )
            metadata["execution_device_id"] = profile["device_id"]
        connection.execute(
            loop_items.update()
            .where(loop_items.c.id == row["id"])
            .values(metadata=metadata)
        )
    migrated_ids = list(migrated_profiles)
    if migrated_ids:
        executions = (
            connection.execute(
                sa.select(
                    loop_item_executions.c.id,
                    loop_item_executions.c.execution_payload,
                    loop_item_executions.c.version,
                )
            )
            .mappings()
            .all()
        )
        for execution in executions:
            try:
                payload = json.loads(execution["execution_payload"] or "{}")
            except (TypeError, ValueError):
                continue
            if str(payload.get("runtime_profile_id") or "") not in migrated_profiles:
                continue
            connection.execute(
                loop_item_executions.update()
                .where(loop_item_executions.c.id == execution["id"])
                .values(
                    execution_payload="",
                    version=int(execution["version"] or 1) + 1,
                )
            )
        migrated_binding_ids = [row["id"] for row in migrated_local_bindings.values()]
        if migrated_binding_ids:
            connection.execute(
                loop_items.delete().where(loop_items.c.id.in_(migrated_binding_ids))
            )
        connection.execute(loop_items.delete().where(loop_items.c.id.in_(migrated_ids)))
