# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""OAuth credentials reach the transport used by DingTalk imported copies."""

import json
import time
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from sqlalchemy.orm import Session

from app.models.user import User
from app.services.knowledge.external_document_providers import (
    DingTalkExternalDocumentProvider,
    ExternalDocumentFetchError,
)
from app.services.user_mcp_service import user_mcp_service

from .conftest import create_synced_node


@pytest.fixture
def test_db(mcp_test_db: Session) -> Session:
    return mcp_test_db


def configure_service(
    db: Session,
    user: User,
    service_id: str = "docs",
    *,
    auth_mode: str = "oauth",
    access_token: str = "docs-access",
    expires_at: int | None = None,
) -> None:
    preferences = user_mcp_service.set_provider_service_config(
        user.preferences,
        provider_id="dingtalk",
        service_id=service_id,
        enabled=True,
        url=f"https://mcp.example.test/{service_id}",
        auth_mode=auth_mode,
    )
    if auth_mode == "oauth" and access_token:
        preferences = user_mcp_service.save_service_oauth_credentials(
            preferences,
            "dingtalk",
            service_id,
            access_token=access_token,
            refresh_token=f"{service_id}-refresh",
            expires_at=(
                expires_at if expires_at is not None else int(time.time()) + 7200
            ),
        )
    user.preferences = user_mcp_service.dump_preferences(preferences)
    db.commit()


@pytest.fixture
def mcp_transport(monkeypatch: pytest.MonkeyPatch) -> SimpleNamespace:
    """Replace only the external MCP client boundary and observe credentials."""
    import mcp
    from mcp.client import streamable_http

    state = SimpleNamespace(connections=[], calls=[], extension="adoc")

    @asynccontextmanager
    async def transport(**kwargs):
        state.connections.append(kwargs)
        yield kwargs, None, None

    class ClientSession:
        def __init__(self, reader, writer, **kwargs):
            self.connection = reader

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def initialize(self):
            return None

        async def call_tool(self, name, arguments):
            state.calls.append((name, arguments))
            if name == "get_document_info":
                payload = {
                    "success": True,
                    "name": "OAuth Document",
                    "nodeType": "file",
                    "contentType": "ALIDOC",
                    "extension": state.extension,
                    "updateTime": 1789562644000,
                }
            elif name == "submit_export_job":
                payload = {"success": True, "jobId": "export-1"}
            elif name == "query_export_job":
                payload = {
                    "success": True,
                    "jobId": "export-1",
                    "status": "success",
                    "downloadUrl": "https://download.example.test/sheet.xlsx",
                }
            elif name == "export_data":
                payload = {
                    "status": "success",
                    "data": {
                        "status": "success",
                        "fileName": "table.xlsx",
                        "downloadUrl": "https://download.example.test/sheet.xlsx",
                    },
                }
            else:
                payload = {"success": True, "markdown": "# OAuth body"}
            return SimpleNamespace(
                isError=False,
                content=[SimpleNamespace(type="text", text=json.dumps(payload))],
            )

    monkeypatch.setattr(streamable_http, "streamablehttp_client", transport)
    monkeypatch.setattr(mcp, "ClientSession", ClientSession)
    return state


@pytest.mark.asyncio
async def test_import_sends_the_owners_docs_oauth_token(
    test_db, test_user, mcp_transport
) -> None:
    configure_service(test_db, test_user)
    create_synced_node(test_db, test_user.id, "oauth-doc")

    result = await DingTalkExternalDocumentProvider().fetch_content(
        test_db, test_user, "oauth-doc"
    )

    assert result.content == b"# OAuth body"
    assert mcp_transport.connections == [
        {
            "url": "https://mcp.example.test/docs",
            "headers": {"Authorization": "Bearer docs-access"},
            "sse_read_timeout": 180,
        }
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "extension,service_id", [("axls", "table"), ("able", "ai_table")]
)
async def test_spreadsheet_export_uses_its_own_service_token(
    test_db, test_user, monkeypatch, mcp_transport, extension, service_id
) -> None:
    configure_service(test_db, test_user)
    configure_service(test_db, test_user, "table", access_token="table-access")
    configure_service(test_db, test_user, "ai_table", access_token="ai-table-access")
    node = create_synced_node(test_db, test_user.id, "oauth-sheet")
    node.raw_metadata = {"extension": extension}
    test_db.commit()
    mcp_transport.extension = extension
    download = AsyncMock(return_value=b"xlsx body")
    monkeypatch.setattr(
        "app.services.knowledge.external_document_providers.download_content", download
    )

    result = await DingTalkExternalDocumentProvider().fetch_content(
        test_db, test_user, "oauth-sheet"
    )

    assert result.content == b"xlsx body"
    assert result.file_extension == "xlsx"
    assert [connection["url"] for connection in mcp_transport.connections] == [
        "https://mcp.example.test/docs",
        f"https://mcp.example.test/{service_id}",
    ]
    export_token = "table-access" if service_id == "table" else "ai-table-access"
    assert [connection["headers"] for connection in mcp_transport.connections] == [
        {"Authorization": "Bearer docs-access"},
        {"Authorization": f"Bearer {export_token}"},
    ]
    # MCP credentials must not travel to the signed download endpoint.
    download.assert_awaited_once_with("https://download.example.test/sheet.xlsx")


@pytest.mark.asyncio
async def test_timestamp_probe_sends_docs_oauth_token(
    test_db, test_user, mcp_transport
) -> None:
    configure_service(test_db, test_user)

    result = await DingTalkExternalDocumentProvider().get_update_time(
        test_db, test_user, "oauth-doc"
    )

    assert result == 1789562644000
    assert mcp_transport.connections[0]["headers"] == {
        "Authorization": "Bearer docs-access"
    }
    assert mcp_transport.calls == [("get_document_info", {"nodeId": "oauth-doc"})]


@pytest.mark.asyncio
async def test_import_refreshes_expired_oauth_before_connecting(
    test_db, test_user, mcp_transport, httpx_mock
) -> None:
    configure_service(test_db, test_user, expires_at=int(time.time()) - 60)
    preferences = user_mcp_service.set_provider_oauth_client(
        test_user.preferences,
        "dingtalk",
        {
            "client_id": "test-client",
            "token_endpoint": "https://mcp.example.test/token",
        },
    )
    test_user.preferences = user_mcp_service.dump_preferences(preferences)
    test_db.commit()
    create_synced_node(test_db, test_user.id, "oauth-doc")
    httpx_mock.add_response(
        method="POST",
        url="https://mcp.example.test/token",
        json={"access_token": "renewed-docs-access", "expires_in": 7200},
    )

    await DingTalkExternalDocumentProvider().fetch_content(
        test_db, test_user, "oauth-doc"
    )

    assert mcp_transport.connections[0]["headers"] == {
        "Authorization": "Bearer renewed-docs-access"
    }
    assert b"grant_type=refresh_token" in httpx_mock.get_request().content


@pytest.mark.asyncio
@pytest.mark.parametrize("operation", ["import", "probe"])
async def test_missing_oauth_reports_reauthorization_without_connecting(
    test_db, test_user, test_admin_user, mcp_transport, operation
) -> None:
    configure_service(test_db, test_admin_user, access_token="other-users-access")
    configure_service(test_db, test_user, access_token="")
    create_synced_node(test_db, test_user.id, "oauth-doc")
    provider = DingTalkExternalDocumentProvider()

    with pytest.raises(
        ExternalDocumentFetchError, match="reconnect the service"
    ) as error:
        if operation == "import":
            await provider.fetch_content(test_db, test_user, "oauth-doc")
        else:
            await provider.get_update_time(test_db, test_user, "oauth-doc")

    assert error.value.error_code == "dingtalk_authorization_required"
    assert mcp_transport.connections == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "extension,service_id", [("axls", "table"), ("able", "ai_table")]
)
async def test_export_does_not_reuse_docs_token_when_its_grant_is_missing(
    test_db, test_user, mcp_transport, extension, service_id
) -> None:
    configure_service(test_db, test_user)
    configure_service(test_db, test_user, service_id, access_token="")
    node = create_synced_node(test_db, test_user.id, "oauth-sheet")
    node.raw_metadata = {"extension": extension}
    test_db.commit()
    mcp_transport.extension = extension

    with pytest.raises(ExternalDocumentFetchError) as error:
        await DingTalkExternalDocumentProvider().fetch_content(
            test_db, test_user, "oauth-sheet"
        )

    assert error.value.error_code == "dingtalk_authorization_required"
    assert service_id in str(error.value)
    assert len(mcp_transport.connections) == 1
    assert mcp_transport.connections[0]["url"] == "https://mcp.example.test/docs"


@pytest.mark.asyncio
async def test_personal_url_import_does_not_require_oauth(
    test_db, test_user, mcp_transport
) -> None:
    configure_service(test_db, test_user, auth_mode="url")
    create_synced_node(test_db, test_user.id, "url-doc")

    result = await DingTalkExternalDocumentProvider().fetch_content(
        test_db, test_user, "url-doc"
    )

    assert result.content == b"# OAuth body"
    assert mcp_transport.connections[0]["headers"] is None
