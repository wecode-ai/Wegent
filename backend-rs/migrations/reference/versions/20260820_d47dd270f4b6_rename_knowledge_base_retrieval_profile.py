"""Rename the shared knowledge-base retrieval profile config key.

Revision ID: d47dd270f4b6
Revises: 64356fbc03dd
Create Date: 2026-08-20 15:52:19.478341+08:00

"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "d47dd270f4b6"
down_revision: Union[str, Sequence[str], None] = "64356fbc03dd"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

OLD_KEY = "code_wiki_retrieval_profile"
NEW_KEY = "knowledge_base_retrieval_profile"


def _rename_key(source_key: str, target_key: str) -> None:
    connection = op.get_bind()
    target_exists = connection.execute(
        sa.text("SELECT 1 FROM system_configs WHERE config_key = :config_key LIMIT 1"),
        {"config_key": target_key},
    ).first()
    if target_exists is None:
        connection.execute(
            sa.text(
                "UPDATE system_configs SET config_key = :target_key "
                "WHERE config_key = :source_key"
            ),
            {"source_key": source_key, "target_key": target_key},
        )


def upgrade() -> None:
    _rename_key(OLD_KEY, NEW_KEY)


def downgrade() -> None:
    _rename_key(NEW_KEY, OLD_KEY)
