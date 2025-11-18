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


# Test database URL (SQLite in-memory)
TEST_DATABASE_URL = "sqlite:///:memory:"


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

    # Create session factory
    TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

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
        git_info=None
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

    # Override database dependency
    def override_get_db():
        try:
            yield test_db
        finally:
            pass

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
