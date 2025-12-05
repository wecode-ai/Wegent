# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from sqlalchemy import create_engine
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker

from app.core.config import settings
from app.core.wiki_config import wiki_settings

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

# ========== Wiki Database Configuration ==========

# Wiki database connection URL
WIKI_DATABASE_URL = wiki_settings.DATABASE_URL

# Create wiki database engine
wiki_engine = create_engine(
    WIKI_DATABASE_URL,
    pool_pre_ping=True,
    connect_args={"charset": "utf8mb4", "init_command": "SET time_zone = '+08:00'"},
)

# Wiki database session factory
WikiSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=wiki_engine)

# Wiki database base class
WikiBase = declarative_base()


def get_wiki_db():
    """
    Wiki database session dependency
    Creates a new session for each request and automatically closes it after the request ends
    """
    db = WikiSessionLocal()
    try:
        yield db
    finally:
        db.close()
