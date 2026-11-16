# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Disposable InnoDB/Redis state and observed database lock waits."""

import asyncio
import os
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Any, Callable

import pytest
from sqlalchemy import create_engine, event, text
from sqlalchemy.engine import Engine, make_url
from sqlalchemy.orm import sessionmaker

from app.core.cache import RedisCache
from app.models.user import User
from app.services import user_mcp_oauth as oauth_module
from app.services import user_mcp_service as service_module
from app.services.user_mcp_oauth import UserMcpOAuthService
from app.services.user_mcp_service import user_mcp_service
from tests.services.test_user_mcp_oauth_concurrency import seed_user


@dataclass
class OAuthContext:
    engine: Engine
    sessions: sessionmaker
    user_id: int

    def credentials(self, service: str = "docs") -> dict[str, Any]:
        with self.sessions() as db:
            return user_mcp_service.get_service_oauth_credentials(
                db.get(User, self.user_id).preferences, "dingtalk", service
            )

    def refresh(self, service: str = "docs", asynchronous: bool = False) -> str:
        with self.sessions() as db:
            kwargs = {
                "user": db.get(User, self.user_id),
                "provider_id": "dingtalk",
                "service_id": service,
            }
            if asynchronous:
                return asyncio.run(
                    UserMcpOAuthService.ensure_access_token(db, **kwargs)
                )
            return UserMcpOAuthService.ensure_access_token_sync(db, **kwargs)

    def authorization(self) -> dict[str, Any]:
        session_id = str(uuid.uuid4())
        _, snapshot = user_mcp_service.start_authorization(
            self.user_id, "dingtalk", "docs", session_id
        )
        return {
            "user_id": self.user_id,
            "provider_id": "dingtalk",
            "service_id": "docs",
            "session_id": session_id,
            "service_snapshot": snapshot,
        }


@pytest.fixture
def oauth_context(monkeypatch):
    url = make_url(os.environ["MCP_OAUTH_TEST_MYSQL_URL"])
    assert url.get_backend_name() == "mysql"
    assert url.host in {"127.0.0.1", "localhost", "mysql"}
    redis_url = os.environ["MCP_OAUTH_TEST_REDIS_URL"]
    assert make_url(redis_url).host in {"127.0.0.1", "localhost", "redis"}
    cache = RedisCache(redis_url)
    assert cache._get_sync_client().ping()
    database = "test_mcp_oauth_" + uuid.uuid4().hex
    admin = create_engine(url.set(database=None), isolation_level="AUTOCOMMIT")
    engine, user_id, created = None, None, False
    monkeypatch.setenv("GIT_TOKEN_AES_KEY", "12345678901234567890123456789012")
    monkeypatch.setenv("GIT_TOKEN_AES_IV", "1234567890123456")
    monkeypatch.setattr(service_module, "cache_manager", cache)
    monkeypatch.setattr(oauth_module, "cache_manager", cache)
    try:
        with admin.connect() as db:
            db.exec_driver_sql(f"CREATE DATABASE `{database}`")
            created = True
        engine = create_engine(
            url.set(database=database),
            isolation_level="REPEATABLE READ",
            pool_size=8,
            connect_args={"init_command": "SET SESSION innodb_lock_wait_timeout=10"},
        )
        User.__table__.create(engine)
        with engine.connect() as db:
            assert (
                db.scalar(text("SELECT @@transaction_isolation")) == "REPEATABLE-READ"
            )
            assert (
                db.scalar(
                    text(
                        "SELECT ENGINE FROM information_schema.TABLES "
                        "WHERE TABLE_SCHEMA=:schema AND TABLE_NAME='users'"
                    ),
                    {"schema": database},
                )
                == "InnoDB"
            )
        sessions = sessionmaker(engine, expire_on_commit=False)
        monkeypatch.setattr(service_module, "SessionLocal", sessions)
        user_id = seed_user(sessions)
        yield OAuthContext(engine, sessions, user_id)
    finally:
        if user_id is not None:
            keys = [
                user_mcp_service.authorization_session_key(user_id, "dingtalk", service)
                for service in ("docs", "table", "ai_table")
            ]
            cache._get_sync_client().delete(*keys)
        asyncio.run(cache.aclose())
        if engine is not None:
            engine.dispose()
        if created:
            with admin.connect() as db:
                db.exec_driver_sql(f"DROP DATABASE `{database}`")
        admin.dispose()


def wait_for_database_lock(context: OAuthContext, connection_id: int) -> None:
    """Require MySQL itself to report the second connection waiting on a lock."""
    deadline = time.monotonic() + 5
    query = text(
        "SELECT COUNT(*) FROM performance_schema.data_lock_waits AS waits "
        "JOIN performance_schema.threads AS threads "
        "ON waits.REQUESTING_THREAD_ID=threads.THREAD_ID "
        "WHERE threads.PROCESSLIST_ID=:connection_id"
    )
    with context.engine.connect() as db:
        while time.monotonic() < deadline:
            if db.scalar(query, {"connection_id": connection_id}):
                return
            threading.Event().wait(0.01)
    raise AssertionError("The competing connection never waited for an InnoDB lock")


def contend(
    context: OAuthContext,
    first: Callable[[], Any],
    second: Callable[[], Any],
    entered: threading.Event,
    release: threading.Event,
) -> tuple[Any, Any]:
    """Release the first transaction only after observing the second lock wait."""
    local = threading.local()
    attempted = threading.Event()
    connections = {}

    def observe(connection, cursor, statement, parameters, execution, executemany):
        if getattr(local, "second", False) and "FOR UPDATE" in statement.upper():
            connections["second"] = connection.connection.driver_connection.thread_id()
            attempted.set()

    def run_second():
        local.second = True
        return second()

    event.listen(context.engine, "before_cursor_execute", observe)
    try:
        with ThreadPoolExecutor(max_workers=2) as workers:
            first_result = workers.submit(first)
            try:
                assert entered.wait(5), "First operation did not reach its pause point"
                second_result = workers.submit(run_second)
                assert attempted.wait(5), "Second operation did not request a row lock"
                wait_for_database_lock(context, connections["second"])
                assert not second_result.done()
            finally:
                release.set()
            return first_result.result(timeout=15), second_result.result(timeout=15)
    finally:
        event.remove(context.engine, "before_cursor_execute", observe)
