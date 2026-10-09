"""unify created_at/updated_at column defaults

Revision ID: f0e1d2c3b4a5
Revises: e6f1a2b3c4d5
Create Date: 2026-10-09

Make the database the single writer of created_at/updated_at:

- created_at -> DEFAULT CURRENT_TIMESTAMP NOT NULL
- updated_at -> DEFAULT CURRENT_TIMESTAMP NOT NULL ON UPDATE CURRENT_TIMESTAMP

Existing column types (including DATETIME(6) fractional precision) are
preserved by reading COLUMN_TYPE from information_schema. MySQL only;
SQLite has no ON UPDATE semantics and is skipped.
"""

import sqlalchemy as sa

from alembic import op

revision = "f0e1d2c3b4a5"
down_revision = "e6f1a2b3c4d5"
branch_labels = None
depends_on = None

TABLES_BOTH = [
    "api_keys",
    "background_executions",
    "dingtalk_synced_nodes",
    "kinds",
    "knowledge_artifacts",
    "knowledge_documents",
    "knowledge_folders",
    "loop_item_executions",
    "loop_items",
    "namespace",
    "namespace_members",
    "plugin_publication_checks",
    "plugin_publication_idempotency",
    "plugin_publication_requests",
    "plugin_publication_revisions",
    "plugin_release_idempotency",
    "plugins",
    "project_chat_messages",
    "projects",
    "queue_messages",
    "resource_members",
    "share_links",
    "smart_app_submissions",
    "smart_apps",
    "subscription_follows",
    "subtask_contexts",
    "subtasks",
    "system_configs",
    "tasks",
    "users",
    "wework_transcripts",
    "wiki_contents",
    "wiki_generations",
    "wiki_projects",
]

TABLES_CREATED_ONLY = [
    "oauth_refresh_tokens",
    "plugin_publication_events",
    "plugin_releases",
    "skill_binaries",
    "smart_app_releases",
    "subscription_share_namespaces",
    "wework_notifications",
    "wework_transcript_archives",
    "wework_transcript_turns",
]

TABLES_UPDATED_ONLY = [
    "marketplace_resources",
    "plugin_device_installations",
]


def _existing_tables() -> set:
    bind = op.get_bind()
    rows = bind.execute(
        # information_schema is always available on MySQL; keeps the migration
        # tolerant of environments where a table was dropped or renamed.
        sa.text(
            "SELECT TABLE_NAME FROM information_schema.TABLES "
            "WHERE TABLE_SCHEMA = DATABASE()"
        )
    )
    return {row[0] for row in rows}


def _column_type(table: str, column: str) -> str:
    bind = op.get_bind()
    row = bind.execute(
        sa.text(
            "SELECT COLUMN_TYPE FROM information_schema.COLUMNS "
            "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :t "
            "AND COLUMN_NAME = :c"
        ),
        {"t": table, "c": column},
    ).fetchone()
    if row is None:
        raise RuntimeError(f"column {table}.{column} not found")
    return row[0]


def _modify(table: str, column: str, on_update: bool) -> None:
    column_type = _column_type(table, column)
    # Strip any existing DEFAULT/ON UPDATE clauses leaked into COLUMN_TYPE
    # (MySQL does not include them, but keep this defensive).
    column_type = column_type.split(" DEFAULT ")[0].split(" ON UPDATE ")[0]
    clause = f"{column_type} NOT NULL DEFAULT CURRENT_TIMESTAMP"
    if on_update:
        clause += " ON UPDATE CURRENT_TIMESTAMP"
    if column_type.lower().endswith("(6)"):
        clause = clause.replace("CURRENT_TIMESTAMP", "CURRENT_TIMESTAMP(6)")
    op.execute(f"ALTER TABLE `{table}` MODIFY `{column}` {clause}")


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "mysql":
        # SQLite has no ON UPDATE CURRENT_TIMESTAMP semantics; unit-test
        # databases are created from models instead.
        return
    existing = _existing_tables()
    for table in TABLES_BOTH:
        if table not in existing:
            continue
        _modify(table, "created_at", on_update=False)
        _modify(table, "updated_at", on_update=True)
    for table in TABLES_CREATED_ONLY:
        if table not in existing:
            continue
        _modify(table, "created_at", on_update=False)
    for table in TABLES_UPDATED_ONLY:
        if table not in existing:
            continue
        _modify(table, "updated_at", on_update=True)


def downgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "mysql":
        return
    existing = _existing_tables()

    def revert(table: str, column: str) -> None:
        column_type = _column_type(table, column)
        op.execute(f"ALTER TABLE `{table}` MODIFY `{column}` {column_type} NOT NULL")

    for table in TABLES_BOTH:
        if table not in existing:
            continue
        revert(table, "created_at")
        revert(table, "updated_at")
    for table in TABLES_CREATED_ONLY:
        if table not in existing:
            continue
        revert(table, "created_at")
    for table in TABLES_UPDATED_ONLY:
        if table not in existing:
            continue
        revert(table, "updated_at")
