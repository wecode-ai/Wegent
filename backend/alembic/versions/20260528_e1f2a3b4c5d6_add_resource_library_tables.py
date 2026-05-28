"""add resource library tables

Revision ID: e1f2a3b4c5d6
Revises: 9d4be4601172
Create Date: 2026-05-28 22:20:00.000000+08:00
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "e1f2a3b4c5d6"
down_revision: Union[str, Sequence[str], None] = "9d4be4601172"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "resource_library_listings",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("resource_type", sa.String(length=20), nullable=False),
        sa.Column("name", sa.String(length=100), nullable=False),
        sa.Column("display_name", sa.String(length=200), nullable=True),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("icon", sa.String(length=100), nullable=True),
        sa.Column("tags", sa.JSON(), nullable=False),
        sa.Column("publisher_user_id", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(length=20), nullable=False),
        sa.Column("current_version_id", sa.Integer(), nullable=True),
        sa.Column("install_count", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "resource_type",
            "name",
            "publisher_user_id",
            name="uq_resource_library_listing_owner_name",
        ),
        sqlite_autoincrement=True,
        mysql_charset="utf8mb4",
        mysql_collate="utf8mb4_unicode_ci",
        mysql_engine="InnoDB",
    )
    op.create_index(
        "ix_resource_library_listings_discovery",
        "resource_library_listings",
        ["status", "resource_type", "updated_at"],
    )
    op.create_index(
        "ix_resource_library_listings_publisher_user_id",
        "resource_library_listings",
        ["publisher_user_id"],
    )
    op.create_index(
        "ix_resource_library_listings_resource_type",
        "resource_library_listings",
        ["resource_type"],
    )
    op.create_index(
        "ix_resource_library_listings_status",
        "resource_library_listings",
        ["status"],
    )

    op.create_table(
        "resource_library_versions",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("listing_id", sa.Integer(), nullable=False),
        sa.Column("version", sa.String(length=50), nullable=False),
        sa.Column("manifest", sa.JSON(), nullable=False),
        sa.Column("source_kind_id", sa.Integer(), nullable=True),
        sa.Column("source_binary_id", sa.Integer(), nullable=True),
        sa.Column("is_current", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(
            ["listing_id"],
            ["resource_library_listings.id"],
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "listing_id",
            "version",
            name="uq_resource_library_version_listing_version",
        ),
        sqlite_autoincrement=True,
        mysql_charset="utf8mb4",
        mysql_collate="utf8mb4_unicode_ci",
        mysql_engine="InnoDB",
    )
    op.create_index(
        "ix_resource_library_versions_current",
        "resource_library_versions",
        ["listing_id", "is_current"],
    )
    op.create_index(
        "ix_resource_library_versions_is_current",
        "resource_library_versions",
        ["is_current"],
    )
    op.create_index(
        "ix_resource_library_versions_listing_id",
        "resource_library_versions",
        ["listing_id"],
    )

    op.create_table(
        "resource_library_installs",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("listing_id", sa.Integer(), nullable=False),
        sa.Column("version_id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("resource_type", sa.String(length=20), nullable=False),
        sa.Column("installed_kind_id", sa.Integer(), nullable=True),
        sa.Column("installed_reference", sa.JSON(), nullable=False),
        sa.Column("install_status", sa.String(length=20), nullable=False),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("installed_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(
            ["listing_id"],
            ["resource_library_listings.id"],
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["version_id"],
            ["resource_library_versions.id"],
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "listing_id",
            "user_id",
            name="uq_resource_library_install_listing_user",
        ),
        sqlite_autoincrement=True,
        mysql_charset="utf8mb4",
        mysql_collate="utf8mb4_unicode_ci",
        mysql_engine="InnoDB",
    )
    op.create_index(
        "ix_resource_library_installs_listing_id",
        "resource_library_installs",
        ["listing_id"],
    )
    op.create_index(
        "ix_resource_library_installs_resource_type",
        "resource_library_installs",
        ["resource_type"],
    )
    op.create_index(
        "ix_resource_library_installs_user_id",
        "resource_library_installs",
        ["user_id"],
    )
    op.create_index(
        "ix_resource_library_installs_user_type_status",
        "resource_library_installs",
        ["user_id", "resource_type", "install_status"],
    )
    op.create_index(
        "ix_resource_library_installs_version_id",
        "resource_library_installs",
        ["version_id"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_resource_library_installs_version_id",
        table_name="resource_library_installs",
    )
    op.drop_index(
        "ix_resource_library_installs_user_type_status",
        table_name="resource_library_installs",
    )
    op.drop_index(
        "ix_resource_library_installs_user_id",
        table_name="resource_library_installs",
    )
    op.drop_index(
        "ix_resource_library_installs_resource_type",
        table_name="resource_library_installs",
    )
    op.drop_index(
        "ix_resource_library_installs_listing_id",
        table_name="resource_library_installs",
    )
    op.drop_table("resource_library_installs")
    op.drop_index(
        "ix_resource_library_versions_listing_id",
        table_name="resource_library_versions",
    )
    op.drop_index(
        "ix_resource_library_versions_is_current",
        table_name="resource_library_versions",
    )
    op.drop_index(
        "ix_resource_library_versions_current",
        table_name="resource_library_versions",
    )
    op.drop_table("resource_library_versions")
    op.drop_index(
        "ix_resource_library_listings_status",
        table_name="resource_library_listings",
    )
    op.drop_index(
        "ix_resource_library_listings_resource_type",
        table_name="resource_library_listings",
    )
    op.drop_index(
        "ix_resource_library_listings_publisher_user_id",
        table_name="resource_library_listings",
    )
    op.drop_index(
        "ix_resource_library_listings_discovery",
        table_name="resource_library_listings",
    )
    op.drop_table("resource_library_listings")
