# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import hashlib
import os
import tempfile
from datetime import datetime, timedelta
from typing import Generator, Tuple

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import Settings
from app.core.security import create_access_token, get_password_hash
from app.db.base import Base

# Import all models to ensure they are registered with same Base instance
from app.models import *
from app.models.api_key import KEY_TYPE_PERSONAL, APIKey

# Import all models to ensure they are registered with Base
from app.models.kind import Kind
from app.models.shared_team import SharedTeam
from app.models.skill_binary import SkillBinary
from app.models.subtask import Subtask
from app.models.user import User


def get_test_database_url(worker_id: str = "master") -> str:
    """
    Generate a unique database URL for each pytest-xdist worker.
    For single-process runs (worker_id="master"), use in-memory database.
    For parallel runs, use file-based databases to avoid conflicts.
    """
    if worker_id == "master":
        # Single process: use in-memory database with shared cache
        return "sqlite:///file:testdb?mode=memory&cache=shared&uri=true"
    else:
        # Parallel: use unique file-based database per worker
        tmp_dir = tempfile.gettempdir()
        db_path = os.path.join(tmp_dir, f"test_wegent_{worker_id}.db")
        return f"sqlite:///{db_path}"


# Session-scoped engine and tables - created once per test session (per worker)
@pytest.fixture(scope="session")
def test_engine(worker_id):
    """
    Create a test database engine once per test session (per worker).
    This significantly speeds up tests by avoiding repeated engine creation.
    """
    db_url = get_test_database_url(worker_id)
    engine = create_engine(db_url, connect_args={"check_same_thread": False})
    Base.metadata.create_all(bind=engine)
    yield engine
    Base.metadata.drop_all(bind=engine)
    engine.dispose()
    # Clean up file-based database if used
    if worker_id != "master":
        tmp_dir = tempfile.gettempdir()
        db_path = os.path.join(tmp_dir, f"test_wegent_{worker_id}.db")
        if os.path.exists(db_path):
            os.remove(db_path)


@pytest.fixture(scope="session")
def worker_id(request):
    """
    Get the pytest-xdist worker id.
    Returns 'master' for single-process runs.
    """
    if hasattr(request.config, "workerinput"):
        return request.config.workerinput["workerid"]
    return "master"


@pytest.fixture(scope="session")
def test_session_factory(test_engine):
    """
    Create a session factory once per test session.
    """
    return sessionmaker(
        autocommit=False, autoflush=False, bind=test_engine, expire_on_commit=False
    )


@pytest.fixture(scope="function")
def test_db(test_engine, test_session_factory) -> Generator[Session, None, None]:
    """
    Create a test database session with transaction rollback.
    Each test function gets a clean database state via transaction rollback.
    This is much faster than recreating tables for each test.
    """
    # Start a connection and begin a transaction
    connection = test_engine.connect()
    transaction = connection.begin()

    # Create a session bound to this connection
    db = test_session_factory(bind=connection)

    # Begin a nested transaction (savepoint)
    nested = connection.begin_nested()

    # If the application code calls session.commit(), restart the nested transaction
    @event.listens_for(db, "after_transaction_end")
    def restart_savepoint(session, trans):
        nonlocal nested
        if trans.nested and not trans._parent.nested:
            nested = connection.begin_nested()

    try:
        yield db
    finally:
        db.close()
        # Rollback the transaction to restore database state
        transaction.rollback()
        connection.close()


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
        REDIS_URL="redis://localhost:6379/1",
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
        git_info=None,
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
        role="admin",
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
        git_info=None,
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
    from app.api.dependencies import get_db
    from app.main import create_app

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


@pytest.fixture(scope="function")
def test_api_key(test_db: Session, test_user: User) -> Tuple[str, APIKey]:
    """
    Create a test API key for the test user.
    Returns a tuple of (raw_key, api_key_record).
    """
    raw_key = "wg-test-api-key-12345"
    key_hash = hashlib.sha256(raw_key.encode()).hexdigest()
    api_key = APIKey(
        user_id=test_user.id,
        key_hash=key_hash,
        key_prefix="wg-test...",
        name="Test API Key",
        key_type=KEY_TYPE_PERSONAL,
        description="Test API key for unit tests",
        expires_at=datetime.utcnow() + timedelta(days=365),
        is_active=True,
    )
    test_db.add(api_key)
    test_db.commit()
    test_db.refresh(api_key)
    return raw_key, api_key


@pytest.fixture(scope="function")
def test_admin_api_key(test_db: Session, test_admin_user: User) -> Tuple[str, APIKey]:
    """
    Create a test API key for the admin user.
    Returns a tuple of (raw_key, api_key_record).
    """
    raw_key = "wg-admin-api-key-12345"
    key_hash = hashlib.sha256(raw_key.encode()).hexdigest()
    api_key = APIKey(
        user_id=test_admin_user.id,
        key_hash=key_hash,
        key_prefix="wg-admin...",
        name="Admin API Key",
        key_type=KEY_TYPE_PERSONAL,
        description="Admin API key for unit tests",
        expires_at=datetime.utcnow() + timedelta(days=365),
        is_active=True,
    )
    test_db.add(api_key)
    test_db.commit()
    test_db.refresh(api_key)
    return raw_key, api_key
