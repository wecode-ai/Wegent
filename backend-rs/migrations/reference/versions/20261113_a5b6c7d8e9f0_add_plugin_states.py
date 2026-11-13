"""Move plugin synchronization documents behind durable plugin identities.

Revision ID: a5b6c7d8e9f0
Revises: f3a7c9e1b2d4
"""

from copy import deepcopy

import sqlalchemy as sa
from alembic import op

from app.services.plugin_state_documents import merge_account as _merge_account
from app.services.plugin_state_documents import validate_document as _validate_document

revision = "a5b6c7d8e9f0"
down_revision = "f3a7c9e1b2d4"
branch_labels = None
depends_on = None


def _tables():
    metadata = sa.MetaData()
    kinds = sa.Table("kinds", metadata, autoload_with=op.get_bind())
    states = sa.Table("plugin_states", metadata, autoload_with=op.get_bind())
    return kinds, states


def _unique_rows(rows, identity):
    result = {}
    for row in rows:
        key = tuple(row[field] for field in identity)
        if key in result:
            raise RuntimeError(
                f"Ambiguous plugin state migration identity={key}; "
                "repair duplicate source records before migrating"
            )
        result[key] = row
    return result


def upgrade():
    """Create the new identities without reading or rewriting historical kinds."""
    identifier = sa.BigInteger().with_variant(sa.Integer(), "sqlite")
    op.create_table(
        "plugin_states",
        sa.Column("id", identifier, primary_key=True, autoincrement=True),
        sa.Column("user_id", identifier, nullable=False),
        sa.Column("plugin_key", sa.String(100), nullable=False),
        sa.Column(
            "installed_kind_id", sa.Integer(), nullable=False, server_default="0"
        ),
        sa.Column("json", sa.JSON(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()
        ),
        sa.Column(
            "updated_at", sa.DateTime(), nullable=False, server_default=sa.func.now()
        ),
        sa.UniqueConstraint(
            "user_id", "plugin_key", name="uniq_plugin_states_identity"
        ),
        mysql_engine="InnoDB",
        mysql_charset="utf8mb4",
        mysql_collate="utf8mb4_unicode_ci",
        comment="Plugin-scoped synchronization identities and transaction fences",
    )


def downgrade():
    bind = op.get_bind()
    kinds, states = _tables()
    existing = _unique_rows(
        bind.execute(
            sa.select(kinds).where(
                kinds.c.kind == "PluginSyncState",
                kinds.c.namespace == "plugin-sync",
                kinds.c.name == "account",
                kinds.c.is_active.is_(True),
                kinds.c.user_id.in_(sa.select(states.c.user_id).distinct()),
            )
        ).mappings(),
        ("user_id",),
    )
    accounts = {}
    for (user_id,), row in existing.items():
        _validate_document(row["json"])
        accounts[user_id] = deepcopy(row["json"])
    for row in bind.execute(sa.select(states)).mappings():
        _validate_document(row["json"])
        document = accounts.setdefault(
            row["user_id"],
            {
                "apiVersion": "agent.wecode.io/v1",
                "kind": "PluginSyncState",
                "metadata": {"name": "account", "namespace": "plugin-sync"},
                "spec": {},
            },
        )
        _merge_account(document.setdefault("spec", {}), row["json"].get("spec", {}))
    for user_id, document in accounts.items():
        document["spec"].pop("legacyActive", None)
        old = existing.get((user_id,))
        if old is not None:
            bind.execute(
                kinds.update()
                .where(
                    kinds.c.id == old["id"],
                    kinds.c.user_id == user_id,
                    kinds.c.kind == "PluginSyncState",
                    kinds.c.namespace == "plugin-sync",
                    kinds.c.name == "account",
                )
                .values(json=document)
            )
        else:
            bind.execute(
                kinds.insert().values(
                    user_id=user_id,
                    kind="PluginSyncState",
                    namespace="plugin-sync",
                    name="account",
                    is_active=True,
                    json=document,
                    created_at=sa.func.now(),
                    updated_at=sa.func.now(),
                )
            )
    op.drop_table("plugin_states")
