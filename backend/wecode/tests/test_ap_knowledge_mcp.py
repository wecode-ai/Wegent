# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Route

from app.mcp_server.server import register_mcp_apps
from app.services.auth import create_task_token
from wecode.mcp_server import ap_knowledge


def _task_token(*, expires_delta_minutes: int = 1440) -> str:
    return create_task_token(
        task_id=1,
        subtask_id=2,
        user_id=3,
        user_name="tester",
        expires_delta_minutes=expires_delta_minutes,
    )


def _call_search(
    client: TestClient,
    token: str | None,
    *,
    max_results: int = 10,
) -> dict:
    headers = {
        "Accept": "application/json, text/event-stream",
        "Content-Type": "application/json",
    }
    if token is not None:
        headers["Authorization"] = f"Bearer {token}"

    response = client.post(
        "/sse",
        headers=headers,
        json={
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {
                "name": "ap_kb_search_knowledge_base",
                "arguments": {
                    "knowledge_base_id": "kb-1",
                    "query": "roadmap",
                    "max_results": max_results,
                },
            },
        },
    )

    assert response.status_code == 200
    return response.json()["result"]


async def test_ap_mcp_schema_exposes_max_results_bounds():
    tools = await ap_knowledge.ap_knowledge_mcp_server.list_tools()
    tool = next(tool for tool in tools if tool.name == "ap_kb_search_knowledge_base")
    max_results_schema = tool.inputSchema["properties"]["max_results"]

    assert max_results_schema["minimum"] == 1
    assert max_results_schema["maximum"] == 50


def test_ap_mcp_is_mounted_and_sets_task_auth_context():
    async def context_response(_request):
        token_info = ap_knowledge._ap_request_token_info.get()
        return JSONResponse(
            {
                "task_id": token_info.task_id if token_info else None,
                "subtask_id": token_info.subtask_id if token_info else None,
                "user_id": token_info.user_id if token_info else None,
            }
        )

    fake_transport = Starlette(routes=[Route("/", context_response, methods=["GET"])])
    with patch.object(
        ap_knowledge.ap_knowledge_mcp_server,
        "streamable_http_app",
        return_value=fake_transport,
    ):
        app = FastAPI()
        register_mcp_apps(app)
        response = TestClient(app).get(
            "/mcp/ap-knowledge/sse",
            headers={"Authorization": f"Bearer {_task_token()}"},
        )

    assert response.status_code == 200
    assert response.json() == {"task_id": 1, "subtask_id": 2, "user_id": 3}


def test_ap_mcp_tool_call_uses_task_authentication():
    db = MagicMock()
    db.query.return_value.filter.return_value.first.return_value = SimpleNamespace(
        id=3,
        is_active=True,
    )
    result = SimpleNamespace(model_dump_json=lambda: '{"records":[]}')

    with (
        patch.object(ap_knowledge, "get_db_session") as get_db_session,
        patch.object(
            ap_knowledge.external_knowledge_service,
            "search",
            new=AsyncMock(return_value=result),
        ) as search,
        TestClient(ap_knowledge.build_ap_knowledge_mcp_app()) as client,
    ):
        get_db_session.return_value.__enter__.return_value = db

        success = _call_search(client, _task_token())
        assert success["isError"] is False
        assert success["content"][0]["text"] == '{"records":[]}'

        for token in (
            None,
            "invalid",
            _task_token(expires_delta_minutes=-1),
        ):
            error = _call_search(client, token)
            assert error["isError"] is True
            assert '"code":"unauthorized"' in error["content"][0]["text"]

        invalid_limit = _call_search(client, _task_token(), max_results=0)
        assert invalid_limit["isError"] is True
        assert (
            "Input should be greater than or equal to 1"
            in invalid_limit["content"][0]["text"]
        )

    search.assert_awaited_once_with(
        db,
        db.query.return_value.filter.return_value.first.return_value,
        "ap",
        query="roadmap",
        knowledge_base_ids=["kb-1"],
        max_results=10,
    )
