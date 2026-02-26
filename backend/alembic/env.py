# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import logging
import os
import sys
from logging.config import fileConfig

from sqlalchemy import engine_from_config, inspect, pool, text

from alembic import context

# Add the parent directory to sys.path to import app modules
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

# Import app configuration and models
from app.core.config import settings
from app.db.base import Base

# Import all models to ensure they are registered with SQLAlchemy
from app.models import *  # noqa: F401,F403

# this is the Alembic Config object, which provides
# access to the values within the .ini file in use.
config = context.config

# Override sqlalchemy.url from app settings
config.set_main_option("sqlalchemy.url", settings.DATABASE_URL)

# The initial schema revision ID - all migrations before this were squashed
INITIAL_SCHEMA_REVISION = "020e34b70ee5"

logger = logging.getLogger("alembic.env")

# Interpret the config file for Python logging.
# This line sets up loggers basically.
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# add your model's MetaData object here
# for 'autogenerate' support
# from myapp import mymodel
# target_metadata = mymodel.Base.metadata
target_metadata = Base.metadata

# other values from the config, defined by the needs of env.py,
# can be acquired:
# my_important_option = config.get_main_option("my_important_option")
# ... etc.


def is_sqlite() -> bool:
    """
    Check if the current database is SQLite.

    This helper function can be used in migration scripts to conditionally
    execute database-specific SQL. Import it in migration scripts like:

        from alembic import op
        from alembic.context import config

        def is_sqlite():
            url = config.get_main_option("sqlalchemy.url")
            return url.startswith("sqlite") if url else False

    Or use the dialect name from the connection:

        from alembic import op

        def upgrade():
            bind = op.get_bind()
            if bind.dialect.name == "sqlite":
                # SQLite-specific code
                pass
            else:
                # MySQL-specific code
                pass

    Note: Many existing migrations use raw MySQL SQL. For SQLite compatibility,
    prefer using Alembic's batch operations (op.batch_alter_table) or
    SQLAlchemy's portable operations (op.add_column, op.drop_column, etc.)
    instead of raw SQL when possible.
    """
    url = config.get_main_option("sqlalchemy.url")
    return url.startswith("sqlite") if url else False


def _get_available_revisions() -> set:
    """Get all available revision IDs from the versions directory."""
    versions_dir = os.path.join(os.path.dirname(__file__), "versions")
    revisions = set()

    if not os.path.exists(versions_dir):
        return revisions

    for filename in os.listdir(versions_dir):
        if filename.endswith(".py") and not filename.startswith("__"):
            # Extract revision ID from filename (format: revision_description.py)
            revision_id = filename.split("_")[0]
            if revision_id:
                revisions.add(revision_id)

    return revisions


def _migrate_legacy_alembic_version(connection) -> None:
    """
    Automatically migrate legacy alembic_version records to the new initial schema.

    This handles the case where old migration files were deleted (squashed) and
    the database has a version record pointing to a non-existent migration.

    The function will:
    1. Check if alembic_version table exists
    2. Get the current version from the table
    3. If the version doesn't exist in available migrations, update it to
       INITIAL_SCHEMA_REVISION (assuming the database schema is already up-to-date
       with the initial schema)
    """
    inspector = inspect(connection)

    # Check if alembic_version table exists
    if "alembic_version" not in inspector.get_table_names():
        logger.info("alembic_version table does not exist, skipping legacy migration")
        return

    # Get current version
    result = connection.execute(text("SELECT version_num FROM alembic_version"))
    row = result.fetchone()

    if not row:
        logger.info("No version record found in alembic_version table")
        return

    current_version = row[0]

    # If already at initial schema or newer, no action needed
    if current_version == INITIAL_SCHEMA_REVISION:
        logger.debug(
            f"Database already at initial schema revision {INITIAL_SCHEMA_REVISION}"
        )
        return

    # Get available revisions
    available_revisions = _get_available_revisions()

    # If current version exists in available migrations, no action needed
    if current_version in available_revisions:
        logger.debug(
            f"Current version {current_version} exists in available migrations"
        )
        return

    # Current version doesn't exist - this is a legacy version that was squashed
    logger.warning(
        f"Legacy alembic version detected: {current_version} "
        f"(not found in available migrations). "
        f"Updating to initial schema revision: {INITIAL_SCHEMA_REVISION}"
    )

    # Update to initial schema revision
    connection.execute(
        text("UPDATE alembic_version SET version_num = :new_version"),
        {"new_version": INITIAL_SCHEMA_REVISION},
    )
    connection.commit()

    logger.info(
        f"Successfully migrated alembic_version from {current_version} "
        f"to {INITIAL_SCHEMA_REVISION}"
    )


def run_migrations_offline() -> None:
    """Run migrations in 'offline' mode.

    This configures the context with just a URL
    and not an Engine, though an Engine is acceptable
    here as well.  By skipping the Engine creation
    we don't even need a DBAPI to be available.

    Calls to context.execute() here emit the given string to the
    script output.

    """
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )

    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """Run migrations in 'online' mode.

    In this scenario we need to create an Engine
    and associate a connection with the context.

    """
    # Get database configuration from settings
    configuration = config.get_section(config.config_ini_section, {})

    # Get the database URL to determine which database type we're using
    db_url = config.get_main_option("sqlalchemy.url")
    is_sqlite = db_url.startswith("sqlite") if db_url else False

    # Add database-specific connection arguments
    if is_sqlite:
        # SQLite configuration
        configuration["sqlalchemy.connect_args"] = {"check_same_thread": False}
    else:
        # MySQL configuration
        configuration["sqlalchemy.connect_args"] = {
            "charset": "utf8mb4",
            "init_command": "SET time_zone = '+08:00'",
        }

    connectable = engine_from_config(
        configuration,
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )

    with connectable.connect() as connection:
        # Migrate legacy alembic_version records before running migrations
        # This handles the case where old migration files were squashed
        _migrate_legacy_alembic_version(connection)

        # Configure context with database-specific options
        context_kwargs = {
            "connection": connection,
            "target_metadata": target_metadata,
            # Compare types to detect column type changes
            "compare_type": True,
            # Compare server defaults
            "compare_server_default": True,
        }

        # Enable batch mode for SQLite to handle ALTER TABLE limitations
        # SQLite doesn't support most ALTER TABLE operations natively
        if is_sqlite:
            context_kwargs["render_as_batch"] = True

        context.configure(**context_kwargs)

        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
