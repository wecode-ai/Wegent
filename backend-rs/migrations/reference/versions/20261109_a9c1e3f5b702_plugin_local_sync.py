"""Persist opt-in plugin local operations and recovery snapshots."""

import sqlalchemy as sa
from alembic import op

revision = "a9c1e3f5b702"
down_revision = "f3a7c9e1b2d4"
branch_labels = None
depends_on = None


def upgrade():
    op.execute(
        "CREATE TABLE plugin_local_sync_operations (\n\tid BIGINT NOT NULL AUTO_INCREMENT, \n\tuser_id BIGINT NOT NULL, \n\tinstance_id VARCHAR(128) NOT NULL, \n\toperation_id VARCHAR(128) NOT NULL, \n\trequest_hash VARCHAR(64) NOT NULL DEFAULT '', \n\taction VARCHAR(20) NOT NULL, \n\tinstalled_id BIGINT NOT NULL DEFAULT '0', \n\tdocument JSON NOT NULL, \n\tcreated_at DATETIME(6) NOT NULL, \n\tupdated_at DATETIME(6) NOT NULL, \n\tPRIMARY KEY (id), \n\tCONSTRAINT uniq_plugin_local_operation UNIQUE (user_id, instance_id, operation_id)\n)ENGINE=InnoDB CHARSET=utf8mb4 COLLATE utf8mb4_bin"
    )
    op.execute(
        "CREATE INDEX idx_plugin_local_instance ON plugin_local_sync_operations (user_id, instance_id, action)"
    )


def downgrade():
    connection = op.get_bind()
    if connection.execute(
        sa.text("SELECT COUNT(*) FROM plugin_local_sync_operations")
    ).scalar():
        raise RuntimeError(
            "Drain and archive plugin local sync records before downgrade"
        )
    op.drop_table("plugin_local_sync_operations")
