# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Unified schema initialization baseline for MySQL and SQLite

Revision ID: aa0_unified_schema_init
Revises: None
Create Date: 2025-03-07

This is the new baseline migration that replaces all previous migrations.
It uses SQLAlchemy's Base.metadata.create_all() to create tables in a
database-agnostic way, supporting both MySQL and SQLite.

For NEW databases (MySQL or SQLite):
- Creates all tables using SQLAlchemy models
- Tables are created with proper settings for each database type
  (sqlite_autoincrement for SQLite, InnoDB engine for MySQL, etc.)

For EXISTING MySQL databases (users upgrading):
- The env.py logic detects existing tables and stamps this revision
- No table creation is performed (tables already exist)
- This ensures existing data is preserved

Migration Strategy:
1. All previous MySQL-specific migrations have been removed
2. This single migration serves as the new baseline
3. Future migrations should use SQLAlchemy operations (op.create_table,
   op.add_column, etc.) instead of raw SQL for cross-database compatibility
"""

from typing import Sequence, Union

from sqlalchemy import inspect

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "aa0_unified_schema_init"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _tables_exist() -> bool:
    """
    Check if core tables already exist in the database.

    This is used to detect existing MySQL databases that were created
    by previous migrations. If tables exist, we skip creation.
    """
    conn = op.get_bind()
    inspector = inspect(conn)
    existing_tables = inspector.get_table_names()

    # Check for core tables that should exist in any initialized database
    core_tables = ["users", "kinds", "subtasks"]
    return all(table in existing_tables for table in core_tables)


def _import_all_models():
    """Import all models to ensure they are registered with Base.metadata."""
    # Import all models explicitly to register them with SQLAlchemy
    from app.models.api_key import APIKey  # noqa: F401
    from app.models.kind import Kind  # noqa: F401
    from app.models.knowledge import KnowledgeDocument  # noqa: F401
    from app.models.namespace import Namespace  # noqa: F401
    from app.models.namespace_member import NamespaceMember  # noqa: F401
    from app.models.project import Project  # noqa: F401
    from app.models.resource_member import ResourceMember  # noqa: F401
    from app.models.share_link import ShareLink  # noqa: F401
    from app.models.skill_binary import SkillBinary  # noqa: F401
    from app.models.subscription import BackgroundExecution  # noqa: F401
    from app.models.subscription_follow import (  # noqa: F401
        SubscriptionFollow,
        SubscriptionShareNamespace,
    )
    from app.models.subtask import Subtask  # noqa: F401
    from app.models.subtask_context import SubtaskContext  # noqa: F401
    from app.models.system_config import SystemConfig  # noqa: F401
    from app.models.task import TaskResource  # noqa: F401
    from app.models.user import User  # noqa: F401
    from app.models.wiki import WikiContent, WikiGeneration, WikiProject  # noqa: F401


def _create_all_tables() -> None:
    """
    Create all tables using SQLAlchemy's Base.metadata.create_all().

    This method is database-agnostic and works for both MySQL and SQLite.
    It uses the model definitions which include proper __table_args__ for
    both databases (sqlite_autoincrement, mysql_engine, etc.).
    """
    from app.db.base import Base

    # Import all models to ensure they are registered
    _import_all_models()

    conn = op.get_bind()

    # Create all tables that don't exist yet
    # checkfirst=True ensures we don't try to create tables that already exist
    Base.metadata.create_all(bind=conn, checkfirst=True)


def upgrade() -> None:
    """
    Upgrade schema - Create all tables for new databases.

    For new databases (MySQL or SQLite):
    - Creates all tables using SQLAlchemy models

    For existing databases (MySQL users upgrading):
    - Skips table creation (tables already exist)
    - This migration is stamped by env.py logic
    """
    if _tables_exist():
        # Existing database - tables were created by previous migrations
        # Just log and continue (env.py will stamp this revision)
        print("INFO: Tables already exist, skipping creation (existing database)")
        return

    # New database - create all tables using SQLAlchemy
    _create_all_tables()
    print("INFO: Created all tables using SQLAlchemy models (new database)")


def downgrade() -> None:
    pass
