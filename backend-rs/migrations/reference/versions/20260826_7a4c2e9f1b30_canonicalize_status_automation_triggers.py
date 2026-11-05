"""Canonicalize status automation trigger configuration.

Revision ID: 7a4c2e9f1b30
Revises: 1e1d81b7b5f0
Create Date: 2026-08-26
"""

from typing import Sequence, Union

from alembic import op

revision: str = "7a4c2e9f1b30"
down_revision: Union[str, Sequence[str], None] = "1e1d81b7b5f0"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


CANONICALIZE_STATUS_RULES_SQL = """
UPDATE loop_items
SET metadata = JSON_REMOVE(
        JSON_SET(
            COALESCE(metadata, JSON_OBJECT()),
            '$.event_config.transition',
            'entered_processing'
        ),
        '$.event_config.statuses'
    ),
    version = version + 1,
    updated_at = CURRENT_TIMESTAMP
WHERE resource_type = 'automation_rule'
  AND deleted_at IS NULL
  AND JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.event_type')) = 'task.status_changed'
  AND (
      JSON_UNQUOTE(
          JSON_EXTRACT(metadata, '$.event_config.transition')
      ) <> 'entered_processing'
      OR JSON_EXTRACT(metadata, '$.event_config.transition') IS NULL
      OR JSON_CONTAINS_PATH(metadata, 'one', '$.event_config.statuses') = 1
  )
"""


REMOVE_OBSOLETE_EVENT_FIELDS_SQL = """
UPDATE loop_items
SET metadata = JSON_REMOVE(
        COALESCE(metadata, JSON_OBJECT()),
        '$.event_config.statuses',
        '$.event_config.transition'
    ),
    version = version + 1,
    updated_at = CURRENT_TIMESTAMP
WHERE resource_type = 'automation_rule'
  AND deleted_at IS NULL
  AND COALESCE(
      JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.event_type')),
      ''
  ) <> 'task.status_changed'
  AND (
      JSON_CONTAINS_PATH(metadata, 'one', '$.event_config.statuses') = 1
      OR JSON_CONTAINS_PATH(metadata, 'one', '$.event_config.transition') = 1
  )
"""


RESTORE_LEGACY_STATUS_RULES_SQL = """
UPDATE loop_items
SET metadata = JSON_REMOVE(
        JSON_SET(
            COALESCE(metadata, JSON_OBJECT()),
            '$.event_config.statuses',
            JSON_ARRAY('pending', 'in_progress')
        ),
        '$.event_config.transition'
    ),
    version = version + 1,
    updated_at = CURRENT_TIMESTAMP
WHERE resource_type = 'automation_rule'
  AND deleted_at IS NULL
  AND JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.event_type')) = 'task.status_changed'
  AND JSON_UNQUOTE(
      JSON_EXTRACT(metadata, '$.event_config.transition')
  ) = 'entered_processing'
"""


def upgrade() -> None:
    op.execute(CANONICALIZE_STATUS_RULES_SQL)
    op.execute(REMOVE_OBSOLETE_EVENT_FIELDS_SQL)


def downgrade() -> None:
    op.execute(RESTORE_LEGACY_STATUS_RULES_SQL)
