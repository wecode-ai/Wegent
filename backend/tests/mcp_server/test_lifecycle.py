# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""ASGI lifecycle contracts for mounted streamable HTTP MCP servers."""

import json
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import settings
from app.mcp_server.server import (
    MCP_APP_SPECS,
    mcp_session_managers_lifespan,
    register_mcp_apps,
)
from app.mcp_server.tools import wework_space
from app.models.delivery import CloudProject
from app.models.user import User

MCP_HEADERS = {
    "Accept": "application/json, text/event-stream",
    "Content-Type": "application/json",
}


def _rpc(
    client: TestClient,
    *,
    request_id: int,
    path: str,
    method: str,
    params: dict[str, object],
    token: str | None = None,
) -> dict[str, object]:
    headers = dict(MCP_HEADERS)
    if token:
        headers["Authorization"] = f"Bearer {token}"
    response = client.post(
        path,
        headers=headers,
        json={
            "jsonrpc": "2.0",
            "id": request_id,
            "method": method,
            "params": params,
        },
    )
    assert response.status_code == 200
    return response.json()


def _create_project(db: Session, user: User) -> CloudProject:
    public_id = str(uuid.uuid4())
    project = CloudProject(
        public_id=public_id,
        project_key=f"LIFE{uuid.uuid4().hex[:6].upper()}",
        name="Lifecycle board",
        description="",
        created_by_user_id=user.id,
        storage_prefix=f"projects/{public_id}",
        metadata_json={"task_provider": "local"},
    )
    db.add(project)
    db.commit()
    db.refresh(project)
    return project


def test_mounted_wework_space_streamable_http_uses_parent_asgi_lifespan(
    test_db: Session,
    test_user: User,
    test_task_token: str,
    monkeypatch,
) -> None:
    project = _create_project(test_db, test_user)
    tool_session_factory = sessionmaker(bind=test_db.get_bind())
    monkeypatch.setattr(wework_space, "SessionLocal", tool_session_factory)
    monkeypatch.setattr(settings, "EXTERNAL_KNOWLEDGE_MCP_ENABLED", False)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        async with mcp_session_managers_lifespan():
            yield

    app = FastAPI(lifespan=lifespan)
    register_mcp_apps(app)

    with TestClient(app) as client:
        for request_id, spec in enumerate(MCP_APP_SPECS, start=1):
            transport_path = (
                spec.mount_path
                if spec.transport_path == "/"
                else f"{spec.mount_path}{spec.transport_path}"
            )
            initialized = _rpc(
                client,
                request_id=request_id,
                path=transport_path,
                method="initialize",
                params={
                    "protocolVersion": "2025-11-25",
                    "capabilities": {},
                    "clientInfo": {"name": "lifecycle-test", "version": "1"},
                },
                token=test_task_token,
            )
            assert initialized["result"]["serverInfo"]["name"] == spec.service_name

        listed = _rpc(
            client,
            request_id=20,
            path="/mcp/wework-space/sse",
            method="tools/list",
            params={},
            token=test_task_token,
        )
        unauthenticated = _rpc(
            client,
            request_id=21,
            path="/mcp/wework-space/sse",
            method="tools/call",
            params={
                "name": "list_board_items",
                "arguments": {"space_id": str(project.id)},
            },
        )
        authenticated = _rpc(
            client,
            request_id=22,
            path="/mcp/wework-space/sse",
            method="tools/call",
            params={
                "name": "list_board_items",
                "arguments": {"space_id": str(project.id)},
            },
            token=test_task_token,
        )

    assert {tool["name"] for tool in listed["result"]["tools"]} == {
        "get_current_context",
        "list_spaces",
        "create_space",
        "update_space",
        "list_board_items",
        "search_board_items",
        "create_board_item",
        "get_board_item",
        "get_assignment_candidates",
        "assign_board_item",
        "update_board_item",
        "add_board_item_comment",
        "list_space_files",
        "read_space_file",
        "list_item_attachments",
        "upload_item_attachment",
        "read_item_attachment",
        "delete_item_attachment",
        "list_deliveries",
        "read_delivery",
        "reorder_board_items",
    }
    unauthenticated_text = unauthenticated["result"]["content"][0]["text"]
    authenticated_text = authenticated["result"]["content"][0]["text"]
    assert json.loads(unauthenticated_text) == {"error": "Authentication required"}
    assert json.loads(authenticated_text) == []
