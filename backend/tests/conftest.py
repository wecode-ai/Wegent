# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Global test fixtures and configurations for backend tests
"""

import pytest
from typing import Generator
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, Session
from fastapi.testclient import TestClient
import fakeredis

from app.db.base import Base
from app.models.user import User
from app.core import security
from app.core.config import settings


# Test database URL - using SQLite in-memory database
TEST_DATABASE_URL = "sqlite:///:memory:"


@pytest.fixture(scope="function")
def test_db() -> Generator[Session, None, None]:
    """
    Create a test database session using SQLite in-memory database.
    Each test gets a fresh database and automatic rollback.
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
def test_user(test_db: Session) -> User:
    """
    Create a test user with basic configuration
    """
    user = User(
        user_name="testuser",
        email="test@example.com",
        password_hash=security.get_password_hash("testpassword123"),
        git_info=[],
        is_active=True
    )
    test_db.add(user)
    test_db.commit()
    test_db.refresh(user)
    return user


@pytest.fixture(scope="function")
def test_user_with_git(test_db: Session) -> User:
    """
    Create a test user with Git configuration
    """
    from shared.utils.crypto import encrypt_git_token

    user = User(
        user_name="gituser",
        email="git@example.com",
        password_hash=security.get_password_hash("gitpassword123"),
        git_info=[
            {
                "type": "github",
                "git_domain": "github.com",
                "git_token": encrypt_git_token("ghp_test_token_123456"),
                "git_id": "12345",
                "git_login": "testuser",
                "git_email": "git@example.com"
            }
        ],
        is_active=True
    )
    test_db.add(user)
    test_db.commit()
    test_db.refresh(user)
    return user


@pytest.fixture(scope="function")
def inactive_user(test_db: Session) -> User:
    """
    Create an inactive test user
    """
    user = User(
        user_name="inactiveuser",
        email="inactive@example.com",
        password_hash=security.get_password_hash("inactivepassword123"),
        git_info=[],
        is_active=False
    )
    test_db.add(user)
    test_db.commit()
    test_db.refresh(user)
    return user


@pytest.fixture(scope="function")
def test_token(test_user: User) -> str:
    """
    Generate a valid JWT token for test user
    """
    token_data = {
        "sub": test_user.user_name,
        "username": test_user.user_name
    }
    return security.create_access_token(token_data)


@pytest.fixture(scope="function")
def auth_headers(test_token: str) -> dict:
    """
    Create authorization headers with test token
    """
    return {"Authorization": f"Bearer {test_token}"}


@pytest.fixture(scope="function")
def test_client(test_db: Session) -> TestClient:
    """
    Create a FastAPI test client with test database
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
def mock_redis():
    """
    Create a fake Redis client for testing
    """
    return fakeredis.FakeRedis()


@pytest.fixture(scope="function")
def mock_settings(monkeypatch):
    """
    Mock configuration settings for testing
    """
    test_settings = {
        "SECRET_KEY": "test-secret-key-for-testing-only",
        "ALGORITHM": "HS256",
        "ACCESS_TOKEN_EXPIRE_MINUTES": 60,
        "DATABASE_URL": TEST_DATABASE_URL,
    }

    for key, value in test_settings.items():
        monkeypatch.setattr(settings, key, value)

    return test_settings


@pytest.fixture
def mock_git_token():
    """
    Return a mock encrypted git token for testing
    """
    from shared.utils.crypto import encrypt_git_token
    return encrypt_git_token("test_token_12345")
