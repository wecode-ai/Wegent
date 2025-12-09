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
engine = create_engine(
    SQLALCHEMY_DATABASE_URL,
    pool_pre_ping=True,
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
