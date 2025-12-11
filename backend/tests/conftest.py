# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest
from typing import Generator
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from fastapi.testclient import TestClient

from app.db.base import Base
from app.core.config import Settings
from app.core.security import get_password_hash, create_access_token
from app.models.user import User
# Import all models to ensure they are registered with Base
from app.models.kind import Kind
from app.models.subtask import Subtask
from app.models.shared_team import SharedTeam
from app.models.skill_binary import SkillBinary
# Import all models to ensure they are registered with same Base instance
from app.models import *


# Test database URL (SQLite in-memory with shared cache for thread safety)
TEST_DATABASE_URL = "sqlite:///file:testdb?mode=memory&cache=shared&uri=true"


@pytest.fixture(scope="function")
def test_db() -> Generator[Session, None, None]:
    """
    Create a test database session using SQLite in-memory database.
    Each test function gets a clean database instance.
    """
    # Create test engine
    engine = create_engine(
        TEST_DATABASE_URL,
        connect_args={"check_same_thread": False}
    )

    # Create all tables
    Base.metadata.create_all(bind=engine)

    # Create session factory with expire_on_commit=False to avoid lazy loading issues in tests
    TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine, expire_on_commit=False)

    # Create session
    db = TestingSessionLocal()

    try:
        yield db
    finally:
        db.close()
        # Drop all tables after test
        Base.metadata.drop_all(bind=engine)


@pytest.fixture(scope="function")
def test_settings() -> Settings:
    """
    Create test settings with overridden values.
    """
    return Settings(
        PROJECT_NAME="Test Project",
        DATABASE_URL=TEST_DATABASE_URL,
        SECRET_KEY="test-secret-key-for-testing-only",
        ALGORITHM="HS256",
        ACCESS_TOKEN_EXPIRE_MINUTES=30,
        ENABLE_API_DOCS=False,
        REDIS_URL="redis://localhost:6379/1"
    )


@pytest.fixture(scope="function")
def test_user(test_db: Session) -> User:
    """
    Create a test user in the database.
    """
    user = User(
        user_name="testuser",
        password_hash=get_password_hash("testpassword123"),
        email="test@example.com",
        is_active=True,
        git_info=None
    )
    test_db.add(user)
    test_db.commit()
    test_db.refresh(user)
    return user


@pytest.fixture(scope="function")
def test_admin_user(test_db: Session) -> User:
    """
    Create a test admin user in the database.
    """
    admin = User(
        user_name="admin",
        password_hash=get_password_hash("adminpassword123"),
        email="admin@example.com",
        is_active=True,
        git_info=None,
        role="admin"
    )
    test_db.add(admin)
    test_db.commit()
    test_db.refresh(admin)
    return admin


@pytest.fixture(scope="function")
def test_inactive_user(test_db: Session) -> User:
    """
    Create an inactive test user in the database.
    """
    user = User(
        user_name="inactiveuser",
        password_hash=get_password_hash("inactive123"),
        email="inactive@example.com",
        is_active=False,
        git_info=None
    )
    test_db.add(user)
    test_db.commit()
    test_db.refresh(user)
    return user


@pytest.fixture(scope="function")
def test_token(test_user: User) -> str:
    """
    Create a valid JWT token for the test user.
    """
    return create_access_token(data={"sub": test_user.user_name})


@pytest.fixture(scope="function")
def test_admin_token(test_admin_user: User) -> str:
    """
    Create a valid JWT token for the test admin user.
    """
    return create_access_token(data={"sub": test_admin_user.user_name})


@pytest.fixture(scope="function")
def test_client(test_db: Session) -> TestClient:
    """
    Create a test client with database dependency override.
    """
    from app.main import create_app
    from app.api.dependencies import get_db

    app = create_app()

    # Override database dependency to always return the same test_db session
    def override_get_db():
        try:
            # Return the test_db session directly without yielding
            # This ensures the same session is used across all requests
            yield test_db
        except Exception:
            test_db.rollback()
            raise

    app.dependency_overrides[get_db] = override_get_db

    return TestClient(app)


@pytest.fixture(scope="function")
def mock_redis(mocker):
    """
    Mock Redis client for testing.
    """
    mock_redis_client = mocker.MagicMock()
    mock_redis_client.get.return_value = None
    mock_redis_client.set.return_value = True
    mock_redis_client.delete.return_value = True
    mock_redis_client.exists.return_value = False
    return mock_redis_client
