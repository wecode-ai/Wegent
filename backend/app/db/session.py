# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from sqlalchemy import create_engine
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker

from app.core.config import settings

# Database connection URL (using sync driver)
SQLALCHEMY_DATABASE_URL = settings.DATABASE_URL

# Create sync database engine with timezone configuration
# Pool settings optimized for multi-worker deployments:
# - Increased pool_size and max_overflow to handle concurrent requests
# - pool_recycle: Recycle connections before MySQL's wait_timeout (default 8h)
# - pool_pre_ping: Check connection validity before use
engine = create_engine(
    SQLALCHEMY_DATABASE_URL,
    pool_pre_ping=True,
    pool_size=10,
    max_overflow=20,
    pool_timeout=30,
    pool_recycle=3600,  # Recycle connections every hour to avoid MySQL timeout
    connect_args={"charset": "utf8mb4", "init_command": "SET time_zone = '+08:00'"},
)

# Sync session factory
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

# Declare base class
Base = declarative_base()

# Wiki tables now use the main database (Base)
# Alias for backward compatibility
WikiBase = Base


def get_wiki_db():
    """
    Wiki database session dependency
    Now uses main database session for wiki tables
    """
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
