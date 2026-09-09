"""Pause historical workflows before explicit adoption of role assignment.

Revision ID: a8c2e4f6b0d1
Revises: f7b8c9d0e1a2
Create Date: 2026-09-09
"""

from copy import deepcopy

import sqlalchemy as sa

from alembic import op

revision = "a8c2e4f6b0d1"
down_revision = "f7b8c9d0e1a2"
branch_labels = None
depends_on = None

BACKUP_KEY = "experience_migration"


def _table():
    return sa.table(
        "loop_items",
        sa.column("id", sa.String),
        sa.column("resource_type", sa.String),
        sa.column("status", sa.String),
        sa.column("metadata", sa.JSON),
    )


def upgrade() -> None:
    connection = op.get_bind()
    table = _table()
    for row in connection.execute(sa.select(table)).mappings():
        original = row["metadata"] or {}
        if not isinstance(original, dict) or BACKUP_KEY in original:
            continue
        metadata = deepcopy(original)
        workflow = metadata.get("workflow")
        config = metadata.get("event_config") or {}
        is_workflow = isinstance(workflow, dict) and bool(
            workflow.get("nodes") or workflow.get("advancement_policy") == "ai"
        )
        is_rule = row["resource_type"] == "automation_rule" and bool(
            config.get("runtime_workflow_definition") or config.get("wework_flow")
        )
        is_project = row["resource_type"] == "project" and bool(
            metadata.get("workflow_definition")
        )
        if not (is_workflow or is_rule or is_project):
            continue
        metadata[BACKUP_KEY] = {"metadata": original, "status": row["status"]}
        status = row["status"]
        if is_workflow:
            workflow.update(semantics_version=1, migration_required=True)
            if workflow.get("orchestration_status") != "completed":
                workflow["orchestration_status"] = "paused"
        if is_rule:
            status = "disabled"
        if is_project:
            metadata.pop("workflow_definition")
        connection.execute(
            table.update()
            .where(table.c.id == row["id"])
            .values(
                metadata=metadata,
                status=status,
            )
        )


def downgrade() -> None:
    connection = op.get_bind()
    table = _table()
    for row in connection.execute(sa.select(table)).mappings():
        metadata = row["metadata"] or {}
        backup = metadata.get(BACKUP_KEY) if isinstance(metadata, dict) else None
        if not isinstance(backup, dict):
            continue
        if backup.get("adopted"):
            raise RuntimeError(
                "Cannot roll back adopted Issue work; restore a database backup"
            )
        connection.execute(
            table.update()
            .where(table.c.id == row["id"])
            .values(
                metadata=backup["metadata"],
                status=backup["status"],
            )
        )
