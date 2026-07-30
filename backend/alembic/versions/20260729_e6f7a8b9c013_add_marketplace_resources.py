# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""add marketplace resources index

Revision ID: e6f7a8b9c013
Revises: d5e6f7a8b9c0
Create Date: 2026-07-29
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "e6f7a8b9c013"
down_revision: Union[str, Sequence[str], None] = "d5e6f7a8b9c0"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "marketplace_resources",
        sa.Column(
            "kind_id",
            sa.Integer(),
            autoincrement=False,
            nullable=False,
            comment="Associated Kind resource ID",
        ),
        sa.Column(
            "resource_type",
            sa.String(length=20),
            server_default="",
            nullable=False,
            comment="Resource type: agent or skill",
        ),
        sa.Column(
            "install_count",
            sa.Integer(),
            server_default="0",
            nullable=False,
            comment="Cumulative first-time marketplace installations",
        ),
        sa.Column(
            "published_at",
            sa.DateTime(),
            server_default=sa.func.now(),
            nullable=False,
            comment="Initial marketplace publication time",
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(),
            server_default=sa.func.now(),
            nullable=False,
            comment="Marketplace resource update time",
        ),
        sa.PrimaryKeyConstraint("kind_id"),
        mysql_engine="InnoDB",
        mysql_charset="utf8mb4",
    )
    op.create_index(
        "idx_marketplace_resources_type_updated",
        "marketplace_resources",
        ["resource_type", "updated_at", "kind_id"],
        unique=False,
    )
    op.create_index(
        "idx_marketplace_resources_type_installs",
        "marketplace_resources",
        ["resource_type", "install_count", "updated_at", "kind_id"],
        unique=False,
    )

    kinds = sa.table(
        "kinds",
        sa.column("id", sa.Integer()),
        sa.column("user_id", sa.Integer()),
        sa.column("kind", sa.String()),
        sa.column("json", sa.JSON()),
        sa.column("is_active", sa.Boolean()),
        sa.column("created_at", sa.DateTime()),
        sa.column("updated_at", sa.DateTime()),
    )
    publications = sa.table(
        "marketplace_resources",
        sa.column("kind_id", sa.Integer()),
        sa.column("resource_type", sa.String()),
        sa.column("install_count", sa.Integer()),
        sa.column("published_at", sa.DateTime()),
        sa.column("updated_at", sa.DateTime()),
    )
    resource_members = sa.table(
        "resource_members",
        sa.column("resource_type", sa.String()),
        sa.column("resource_id", sa.Integer()),
        sa.column("status", sa.String()),
    )
    skill_bindings = kinds.alias("skill_bindings")
    visibility = sa.func.json_extract(kinds.c.json, "$.spec.capability.visibility")
    publish_status = sa.func.json_extract(
        kinds.c.json, "$.spec.capability.publishStatus"
    )
    if op.get_bind().dialect.name == "mysql":
        visibility = sa.func.json_unquote(visibility)
        publish_status = sa.func.json_unquote(publish_status)

    agent_counts = (
        sa.select(
            resource_members.c.resource_id.label("kind_id"),
            sa.func.count().label("install_count"),
        )
        .where(
            resource_members.c.resource_type == "Team",
            resource_members.c.status == "approved",
        )
        .group_by(resource_members.c.resource_id)
        .subquery()
    )
    binding_skill_id = sa.func.json_extract(
        skill_bindings.c.json,
        "$.spec.skillRef.skillId",
    )
    if op.get_bind().dialect.name == "mysql":
        binding_skill_id = sa.func.json_unquote(binding_skill_id)
    binding_skill_id = sa.cast(binding_skill_id, sa.Integer())
    skill_counts = (
        sa.select(
            binding_skill_id.label("kind_id"),
            sa.func.count().label("install_count"),
        )
        .where(
            skill_bindings.c.kind == "SkillBinding",
            skill_bindings.c.is_active.is_(True),
        )
        .group_by(binding_skill_id)
        .subquery()
    )

    op.execute(
        publications.insert().from_select(
            [
                "kind_id",
                "resource_type",
                "install_count",
                "published_at",
                "updated_at",
            ],
            sa.select(
                kinds.c.id,
                sa.case(
                    (kinds.c.kind == "Team", "agent"),
                    else_="skill",
                ),
                sa.case(
                    (
                        kinds.c.kind == "Team",
                        sa.func.coalesce(agent_counts.c.install_count, 0),
                    ),
                    else_=sa.func.coalesce(skill_counts.c.install_count, 0),
                ),
                kinds.c.created_at,
                kinds.c.updated_at,
            )
            .outerjoin(
                agent_counts,
                agent_counts.c.kind_id == kinds.c.id,
            )
            .outerjoin(
                skill_counts,
                skill_counts.c.kind_id == kinds.c.id,
            )
            .where(
                kinds.c.user_id != 0,
                kinds.c.kind.in_(["Team", "Skill"]),
                kinds.c.is_active.is_(True),
                visibility == "public",
                publish_status == "published",
            ),
        )
    )


def downgrade() -> None:
    op.drop_index(
        "idx_marketplace_resources_type_installs",
        table_name="marketplace_resources",
    )
    op.drop_index(
        "idx_marketplace_resources_type_updated",
        table_name="marketplace_resources",
    )
    op.drop_table("marketplace_resources")
