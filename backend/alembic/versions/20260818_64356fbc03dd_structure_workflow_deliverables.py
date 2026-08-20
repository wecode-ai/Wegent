"""structure workflow deliverables

Revision ID: 64356fbc03dd
Revises: a3b4c5d6e7f8
Create Date: 2026-08-18

"""

import uuid
from copy import deepcopy
from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "64356fbc03dd"
down_revision: Union[str, Sequence[str], None] = "a3b4c5d6e7f8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


loop_items = sa.table(
    "loop_items",
    sa.column("id", sa.String(64)),
    sa.column("resource_type", sa.String(24)),
    sa.column("metadata", sa.JSON()),
)


def _requirement_id(
    resource_id: str,
    workflow_key: str,
    node_id: str,
    index: int,
    name: str,
) -> str:
    identity = f"wegent:{resource_id}:{workflow_key}:{node_id}:{index}:{name}"
    return uuid.uuid5(uuid.NAMESPACE_URL, identity).hex


def _migrate_nodes(
    resource_id: str,
    workflow_key: str,
    workflow: object,
    *,
    structured: bool,
) -> bool:
    if not isinstance(workflow, dict) or not isinstance(workflow.get("nodes"), list):
        return False
    changed = False
    for node_index, node in enumerate(workflow["nodes"]):
        if not isinstance(node, dict):
            continue
        values = node.get("required_deliverables")
        if not isinstance(values, list):
            continue
        migrated: list[object] = []
        for value_index, value in enumerate(values):
            if structured and isinstance(value, str) and value.strip():
                name = value.strip()
                migrated.append(
                    {
                        "id": _requirement_id(
                            resource_id,
                            workflow_key,
                            str(node.get("id") or node_index),
                            value_index,
                            name,
                        ),
                        "name": name,
                        "description": "",
                        "value_type": "file",
                        "file_constraints": {
                            "accepted_types": [],
                            "min_files": 1,
                            "max_files": 1,
                        },
                    }
                )
                changed = True
            elif not structured and isinstance(value, dict):
                name = str(value.get("name") or "").strip()
                if name:
                    migrated.append(name)
                changed = True
            else:
                migrated.append(value)
        node["required_deliverables"] = migrated
    return changed


def _rewrite(*, structured: bool) -> None:
    connection = op.get_bind()
    rows = connection.execute(
        sa.select(
            loop_items.c.id,
            loop_items.c.resource_type,
            loop_items.c.metadata,
        ).where(loop_items.c.resource_type.in_(("project", "task")))
    ).mappings()
    for row in rows:
        metadata = deepcopy(row["metadata"])
        if not isinstance(metadata, dict):
            continue
        key = "workflow_definition" if row["resource_type"] == "project" else "workflow"
        if not _migrate_nodes(
            str(row["id"]),
            key,
            metadata.get(key),
            structured=structured,
        ):
            continue
        connection.execute(
            loop_items.update()
            .where(loop_items.c.id == row["id"])
            .values(metadata=metadata)
        )


def upgrade() -> None:
    _rewrite(structured=True)


def downgrade() -> None:
    _rewrite(structured=False)
