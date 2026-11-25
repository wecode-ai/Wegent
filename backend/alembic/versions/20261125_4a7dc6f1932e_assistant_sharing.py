"""Create assistant sharing definitions and recipient grants."""

from alembic import op

revision = "4a7dc6f1932e"
down_revision = "b1c2d3e4f5a6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """CREATE TABLE IF NOT EXISTS assistant_share_definitions (
    owner_user_id INT NOT NULL,
    resource_kind ENUM('assistant','team') NOT NULL,
    source_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    definition JSON NOT NULL,
    revision BIGINT UNSIGNED NOT NULL DEFAULT 1,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (owner_user_id, resource_kind, source_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4"""
    )
    op.execute(
        """CREATE TABLE IF NOT EXISTS assistant_share_grants (
    owner_user_id INT NOT NULL,
    resource_kind ENUM('assistant','team') NOT NULL,
    source_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    recipient_user_id INT NOT NULL,
    allow_copy BOOLEAN NOT NULL,
    direct_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    copied_revision BIGINT UNSIGNED NULL,
    revoked_at DATETIME(6) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (owner_user_id, resource_kind, source_id, recipient_user_id),
    KEY assistant_share_recipient (recipient_user_id, revoked_at, owner_user_id, resource_kind, source_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4"""
    )
    op.execute(
        """CREATE TABLE IF NOT EXISTS assistant_team_member_copies (
    owner_user_id INT NOT NULL,
    source_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    recipient_user_id INT NOT NULL,
    copied_revision BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (owner_user_id, source_id, recipient_user_id),
    KEY assistant_member_copy_recipient (recipient_user_id, owner_user_id, source_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4"""
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS assistant_team_member_copies")
    op.execute("DROP TABLE IF EXISTS assistant_share_grants")
    op.execute("DROP TABLE IF EXISTS assistant_share_definitions")
