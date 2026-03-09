# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import logging
import os
import sys
from logging.config import fileConfig

from sqlalchemy import engine_from_config, inspect, pool, text

from alembic import context
from alembic.script import ScriptDirectory

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


def _get_head_revision() -> str:
    """Get the current head revision from the script directory."""
    script = ScriptDirectory.from_config(config)
    return script.get_current_head()


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


def _is_fresh_database(connection) -> bool:
    """
    Check if this is a fresh database (no tables exist).

    A fresh database means:
    1. No alembic_version table exists, AND
    2. No application tables exist (e.g., 'users' table)

    This is used to determine whether to initialize the database
    with Base.metadata.create_all() or run migrations normally.
    """
    inspector = inspect(connection)
    existing_tables = set(inspector.get_table_names())

    # If alembic_version exists, it's not a fresh database
    if "alembic_version" in existing_tables:
        return False

    # Check for any application tables
    # If any of these exist, it's an existing database without alembic tracking
    app_tables = {"users", "kinds", "tasks", "namespaces"}
    if existing_tables & app_tables:
        return False

    return True


def _initialize_fresh_database(connection) -> None:
    """
    Initialize a fresh database with all tables and stamp to head.

    For fresh installations (both MySQL and SQLite), this function:
    1. Creates all tables using SQLAlchemy's Base.metadata.create_all()
    2. Stamps the database to the current head revision

    This approach:
    - Bypasses all old MySQL-specific migrations for new installations
    - Ensures cross-database compatibility (works for both MySQL and SQLite)
    - Future migrations will work normally since we stamp to head
    """
    head_revision = _get_head_revision()
    logger.info(f"Fresh database detected. Initializing with current schema...")

    # Step 1: Create all tables using SQLAlchemy metadata
    # This is cross-database compatible (works for both MySQL and SQLite)
    logger.info("Creating all tables using SQLAlchemy metadata...")
    Base.metadata.create_all(bind=connection, checkfirst=True)
    logger.info("All tables created successfully")

    # Step 2: Create alembic_version table and stamp to head
    logger.info(f"Stamping database to head revision: {head_revision}")
    connection.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS alembic_version (
                version_num VARCHAR(32) NOT NULL,
                CONSTRAINT alembic_version_pkc PRIMARY KEY (version_num)
            )
            """
        )
    )

    # Insert the head revision (skip all migrations since tables are already created)
    connection.execute(
        text("INSERT INTO alembic_version (version_num) VALUES (:version)"),
        {"version": head_revision},
    )
    connection.commit()

    logger.info(f"Database initialized and stamped to head: {head_revision}")


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
    is_sqlite_db = db_url.startswith("sqlite") if db_url else False

    # Add database-specific connection arguments
    if is_sqlite_db:
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
        # For fresh databases, create tables and stamp to head
        # This ensures new users (both MySQL and SQLite) get a working database
        # without running old MySQL-specific migrations
        if _is_fresh_database(connection):
            _initialize_fresh_database(connection)
            # After initialization, no migrations need to run
            # since we've already created all tables and stamped to head
            logger.info("Fresh database initialized. No migrations to run.")
            return

        # For existing databases, run migrations normally
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
        if is_sqlite_db:
            context_kwargs["render_as_batch"] = True

        context.configure(**context_kwargs)

        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
