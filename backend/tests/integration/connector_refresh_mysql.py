"""CI-covered MySQL checks for grant-scoped connector failures."""

import json
import os
import uuid

import httpx
import pytest
from sqlalchemy import create_engine
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session

from app.models.user import User
from app.services.connector_connections import connector_connection_service
from app.services.connector_runtime import ConnectorRuntimeService

SLUG = "mysql-connector-refresh"


def seed_connection(
    db: Session, user_id: int, *, slug: str, access: str, refresh: str | None
):
    return connector_connection_service.save_oauth_connection(
        db,
        slug=slug,
        user_id=user_id,
        access_token=access,
        refresh_token=refresh,
        token_type="bearer",
        granted_scopes=["mcp.read"],
        external_account_name=None,
        expires_at=None,
    )


def app(db: Session, user_id: int, slug: str):
    from app.schemas.connector import ConnectorAppWrite
    from app.services.connector_apps import connector_app_service

    user = db.get(User, user_id)
    if user is None:
        user = User(
            user_name="integration-admin",
            email="integration@example.test",
            password_hash="integration-test-password-hash",
        )
        db.add(user)
        db.flush()
    connector_app_service.create_app(
        db,
        ConnectorAppWrite.model_validate(
            {
                "slug": slug,
                "name": "MySQL connector",
                "mcp_url": "https://connector.example.test/mcp",
                "auth_type": "oauth2",
            }
        ),
        user,
    )
    return connector_app_service.get_app_by_slug(db, slug)


def verify_late_rejection_does_not_expire_newer_grant(engine) -> None:
    """A 401 for A0 must not expire A1 committed meanwhile."""
    with Session(engine) as writer:
        slug = f"{SLUG}-late"
        attempted = seed_connection(writer, 1, slug=slug, access="A0", refresh="R0")
        seed_connection(writer, 1, slug=slug, access="A1", refresh="R1")
        connector = app(writer, 1, slug)
        user = writer.get(User, 1)
        assert not ConnectorRuntimeService._mark_expired_on_auth_error(
            writer,
            app=connector,
            user=user,
            error=RuntimeError("401 unauthorized"),
        ), "a failure without its request grant must not expire the current grant"
        ConnectorRuntimeService._mark_expired_on_auth_error(
            writer,
            app=connector,
            user=user,
            error=RuntimeError("401 unauthorized"),
            attempted=attempted,
        )
    with Session(engine) as reader:
        current = connector_connection_service.get(reader, slug=slug, user_id=1)
        assert current is not None
        assert current.status == "connected"
        assert current.access_token() == "A1"
        assert current.refresh_token() == "R1"


def verify_rejection_expires_only_the_used_grant(engine) -> None:
    """The grant still in use is expired but keeps its refresh token."""
    with Session(engine) as writer:
        slug = f"{SLUG}-used"
        attempted = seed_connection(writer, 1, slug=slug, access="A0", refresh="R0")
        connector = app(writer, 1, slug)
        user = writer.get(User, 1)
        ConnectorRuntimeService._mark_expired_on_auth_error(
            writer,
            app=connector,
            user=user,
            error=RuntimeError("401 unauthorized"),
            attempted=attempted,
        )
    with Session(engine) as reader:
        current = connector_connection_service.get(reader, slug=slug, user_id=1)
        assert current is not None
        assert current.status == "expired"
        assert current.access_token() == "A0"
        assert current.refresh_token() == "R0"


async def verify_rate_limited_refresh_recovers(engine) -> None:
    """A 429 leaves R0 available for a later successful refresh."""
    from app.services.connector_oauth import ConnectorOAuthService
    from shared.utils.crypto import encrypt_sensitive_data

    with Session(engine) as writer:
        slug = f"{SLUG}-429"
        attempted = seed_connection(writer, 1, slug=slug, access="A0", refresh="R0")
        connector = app(writer, 1, slug)
        spec = dict(connector.row.json["spec"])
        spec["oauthClientEncrypted"] = encrypt_sensitive_data(
            json.dumps(
                {
                    "issuer": "https://connector.example.test",
                    "token_endpoint": "https://connector.example.test/token",
                    "client_id": "integration-client",
                }
            )
        )
        connector.row.json = {**connector.row.json, "spec": spec}
        writer.commit()
        response = httpx.Response(
            429, request=httpx.Request("POST", "https://connector.example.test/token")
        )
        error = httpx.HTTPStatusError(
            "rate limited", request=response.request, response=response
        )
        original_post = httpx.AsyncClient.post

        async def limited_post(client, *args, **kwargs):
            raise error

        httpx.AsyncClient.post = limited_post
        try:
            assert (
                await ConnectorOAuthService.refresh_connection(writer, attempted)
                is None
            )
        finally:
            httpx.AsyncClient.post = original_post
        current = connector_connection_service.get(writer, slug=slug, user_id=1)
        assert current is not None
        assert current.refresh_token() == "R0"
        assert current.status == "expired"
        writer.expire_all()
        attempted = connector_connection_service.get(writer, slug=slug, user_id=1)

        async def recovered_post(client, *args, **kwargs):
            return httpx.Response(
                200,
                request=httpx.Request("POST", "https://connector.example.test/token"),
                json={
                    "access_token": "A1",
                    "refresh_token": "R1",
                    "expires_in": 3600,
                },
            )

        httpx.AsyncClient.post = recovered_post
        try:
            renewed = await ConnectorOAuthService.refresh_connection(writer, attempted)
        finally:
            httpx.AsyncClient.post = original_post
        assert renewed is not None
        assert renewed.status == "connected"
        assert renewed.access_token() == "A1"
        assert renewed.refresh_token() == "R1"


@pytest.fixture(scope="module")
def mysql_engine():
    url = make_url(os.environ["CONNECTOR_REFRESH_TEST_MYSQL_URL"])
    if url.get_backend_name() != "mysql" or url.host not in {
        "mysql",
        "127.0.0.1",
        "localhost",
    }:
        raise ValueError("Only an explicitly configured local/CI MySQL is allowed")
    database = "test_connector_refresh_" + uuid.uuid4().hex
    admin = create_engine(url.set(database=None), isolation_level="AUTOCOMMIT")
    engine = None
    try:
        with admin.connect() as connection:
            connection.exec_driver_sql(f"CREATE DATABASE `{database}`")
        engine = create_engine(url.set(database=database))
        from app.db.base import Base

        Base.metadata.create_all(engine)
        yield engine
    finally:
        if engine is not None:
            engine.dispose()
        with admin.connect() as connection:
            connection.exec_driver_sql(f"DROP DATABASE IF EXISTS `{database}`")
        admin.dispose()


def test_late_rejection_does_not_expire_newer_grant(mysql_engine) -> None:
    verify_late_rejection_does_not_expire_newer_grant(mysql_engine)


def test_rejection_expires_only_the_used_grant(mysql_engine) -> None:
    verify_rejection_expires_only_the_used_grant(mysql_engine)


@pytest.mark.asyncio
async def test_rate_limited_refresh_recovers(mysql_engine) -> None:
    await verify_rate_limited_refresh_recovers(mysql_engine)
