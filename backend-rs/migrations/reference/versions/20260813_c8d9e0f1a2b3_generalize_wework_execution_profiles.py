# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Allow AI-manager transport runs without a persisted project robot.

Revision ID: c8d9e0f1a2b3
Revises: b7c6d5e4f3a2
Create Date: 2026-08-13
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "c8d9e0f1a2b3"
down_revision: Union[str, Sequence[str], None] = "b7c6d5e4f3a2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


MIGRATE_ASSIGNMENT_RULES_SQL = """
UPDATE loop_items
SET metadata = JSON_REMOVE(
        JSON_SET(COALESCE(metadata, JSON_OBJECT()), '$.assignment_mode', 'manual'),
        '$.manager_type',
        '$.executor_type'
    ),
    version = version + 1,
    updated_at = CURRENT_TIMESTAMP
WHERE resource_type = 'automation_rule'
  AND deleted_at IS NULL
  AND JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.assignment_mode')) IS NULL
  AND COALESCE(assignee_agent_id, '') <> ''
"""


DISABLE_UNMAPPABLE_RULES_SQL = """
UPDATE loop_items
SET status = 'disabled',
    metadata = JSON_SET(
        COALESCE(metadata, JSON_OBJECT()),
        '$.migration_error',
        'Legacy automation has no valid assignment configuration; choose an assignment mode.'
    ),
    version = version + 1,
    updated_at = CURRENT_TIMESTAMP
WHERE resource_type = 'automation_rule'
  AND deleted_at IS NULL
  AND JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.assignment_mode')) IS NULL
  AND COALESCE(assignee_agent_id, '') = ''
"""


def upgrade() -> None:
    op.add_column(
        "loop_item_executions",
        sa.Column(
            "executor_owner_user_id",
            sa.Integer(),
            nullable=False,
            server_default="0",
            comment="User whose Wework runtime owns this execution",
        ),
    )
    op.add_column(
        "loop_item_executions",
        sa.Column(
            "automation_run_id",
            sa.String(64),
            nullable=False,
            server_default="",
            comment="Owning project automation run id",
        ),
    )
    op.execute(
        "UPDATE loop_item_executions AS execution "
        "LEFT JOIN loop_items AS agent ON agent.id = execution.agent_id "
        "SET execution.executor_owner_user_id = "
        "COALESCE(agent.created_by_user_id, execution.assigner_user_id, 0)"
    )
    op.execute(MIGRATE_ASSIGNMENT_RULES_SQL)
    op.execute(DISABLE_UNMAPPABLE_RULES_SQL)
    op.create_index(
        "idx_exec_automation_run_id",
        "loop_item_executions",
        ["automation_run_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("idx_exec_automation_run_id", table_name="loop_item_executions")
    op.drop_column("loop_item_executions", "automation_run_id")
    op.drop_column("loop_item_executions", "executor_owner_user_id")
