# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

from wecode.models.erp_user import WecodeErpUser
from wecode.service.erp_entity_resolver import (
    EmployeeIdResolution,
    EmployeeIdResolutionStatus,
)
from wecode.service.external_knowledge.client import ApKnowledgeMcpClient
from wecode.service.external_knowledge.providers.ap import (
    LIST_KNOWLEDGE_BASES_TOOL,
    LIST_NODES_TOOL,
    SEARCH_CONTENT_TOOL,
)
from wecode.service.external_knowledge.service import external_knowledge_service

pytestmark = pytest.mark.usefixtures("configure_external_knowledge")


def test_list_knowledge_bases_maps_ap_payload(
    test_client: TestClient,
    auth_headers: dict[str, str],
    erp_profile: WecodeErpUser,
):
    async def fake_call(self, name, arguments, employee_id):
        assert employee_id == "230473"
        assert name == LIST_KNOWLEDGE_BASES_TOOL
        assert arguments == {
            "scope": "organization",
            "limit": 20,
            "offset": 0,
            "query": "quarter",
        }
        return {
            "total": 1,
            "total_returned": 1,
            "has_more": False,
            "limit": 20,
            "offset": 0,
            "items": [
                {
                    "knowledge_base_id": "kb-1",
                    "knowledge_base_name": "Quarterly",
                    "description": "Business reports",
                    "scope": "organization",
                    "owner_id": "ai3c:230473",
                    "employee_id": "230473",
                    "document_count": 12,
                    "created_at": "2026-06-01T00:00:00Z",
                    "updated_at": "2026-06-15T00:00:00Z",
                }
            ],
        }

    with patch.object(ApKnowledgeMcpClient, "call_tool", fake_call):
        response = test_client.get(
            "/api/wecode/external-knowledge/ap/knowledge-bases",
            headers=auth_headers,
            params={"scope": "organization", "query": "quarter", "limit": 20},
        )

    assert response.status_code == 200
    body = response.json()
    assert body["provider"] == "ap"
    assert body["total"] == 1
    assert body["items"][0]["knowledge_base_id"] == "kb-1"
    assert body["items"][0]["scope"] == "organization"


def test_external_knowledge_health_requires_auth(test_client: TestClient):
    mock_health = AsyncMock(
        return_value={
            "provider": "ap",
            "enabled": True,
            "configured": True,
            "ok": True,
            "status": "ok",
        }
    )

    with patch.object(external_knowledge_service, "health", mock_health):
        response = test_client.get("/api/wecode/external-knowledge/ap/health")

    assert response.status_code == 401
    mock_health.assert_not_called()


def test_external_knowledge_health_allows_authenticated_users(
    test_client: TestClient,
    auth_headers: dict[str, str],
):
    mock_health = AsyncMock(
        return_value={
            "provider": "ap",
            "enabled": True,
            "configured": True,
            "ok": True,
            "status": "ok",
        }
    )

    with patch.object(external_knowledge_service, "health", mock_health):
        response = test_client.get(
            "/api/wecode/external-knowledge/ap/health",
            headers=auth_headers,
        )

    assert response.status_code == 200
    assert response.json()["ok"] is True
    mock_health.assert_awaited_once_with("ap")


def test_list_nodes_returns_preview_url_for_current_folder_documents(
    test_client: TestClient,
    auth_headers: dict[str, str],
    erp_profile: WecodeErpUser,
):
    async def fake_call(self, name, arguments, employee_id):
        assert employee_id == "230473"
        assert name == LIST_NODES_TOOL
        assert arguments["recursive"] is False
        return {
            "knowledge_base_id": "kb-1",
            "knowledge_base_name": "Quarterly",
            "folder_id": arguments.get("folder_id"),
            "recursive": False,
            "total_returned": 1,
            "total_available": 1,
            "has_more": False,
            "items": [
                {
                    "node_id": "document:doc-1",
                    "raw_id": "doc-1",
                    "name": "Plan.pdf",
                    "node_type": "document",
                    "previewable": True,
                    "browser_open_url": "https://apgateway.erp.sina.com.cn/raw",
                }
            ],
        }

    with patch.object(ApKnowledgeMcpClient, "call_tool", fake_call):
        response = test_client.get(
            "/api/wecode/external-knowledge/ap/knowledge-bases/kb-1/nodes",
            headers=auth_headers,
        )

    assert response.status_code == 200
    body = response.json()
    assert body["items"][0]["node_id"] == "document:doc-1"
    assert (
        body["items"][0]["browser_open_url"] == "https://apgateway.erp.sina.com.cn/raw"
    )
    assert body["items"][0]["preview"] == {
        "url": "https://apgateway.erp.sina.com.cn/raw",
        "preview_mode": "iframe",
    }


def test_recursive_list_nodes_returns_preview_urls_for_tree_documents(
    test_client: TestClient,
    auth_headers: dict[str, str],
    erp_profile: WecodeErpUser,
):
    async def fake_call(self, name, arguments, employee_id):
        assert employee_id == "230473"
        assert name == LIST_NODES_TOOL
        assert arguments["recursive"] is True
        return {
            "knowledge_base_id": "kb-1",
            "knowledge_base_name": "Quarterly",
            "recursive": True,
            "total_returned": 1,
            "total_available": 1,
            "has_more": False,
            "items": [
                {
                    "node_id": "folder:folder-1",
                    "raw_id": "folder-1",
                    "name": "Folder",
                    "node_type": "folder",
                    "children": [
                        {
                            "node_id": "document:doc-1",
                            "raw_id": "doc-1",
                            "name": "Plan.pdf",
                            "node_type": "document",
                            "previewable": True,
                            "browser_open_url": "https://apgateway.erp.sina.com.cn/raw",
                        }
                    ],
                }
            ],
        }

    with patch.object(ApKnowledgeMcpClient, "call_tool", fake_call):
        response = test_client.get(
            "/api/wecode/external-knowledge/ap/knowledge-bases/kb-1/nodes",
            headers=auth_headers,
            params={"recursive": "true"},
        )

    assert response.status_code == 200
    body = response.json()
    assert "browser_open_url" not in body["items"][0]
    assert (
        body["items"][0]["children"][0]["browser_open_url"]
        == "https://apgateway.erp.sina.com.cn/raw"
    )
    assert body["items"][0]["children"][0]["preview"] == {
        "url": "https://apgateway.erp.sina.com.cn/raw",
        "preview_mode": "iframe",
    }


def test_search_does_not_leak_raw_url_and_returns_source_uri(
    test_client: TestClient,
    auth_headers: dict[str, str],
    erp_profile: WecodeErpUser,
):
    async def fake_call(self, name, arguments, employee_id):
        assert name == SEARCH_CONTENT_TOOL
        return {
            "query": arguments["query"],
            "total": 1,
            "searched_knowledge_base_ids": ["kb-1"],
            "ignored_knowledge_base_ids": [],
            "warnings": [],
            "records": [
                {
                    "content": "matched content",
                    "title": "Plan.pdf",
                    "score": 0.8,
                    "knowledge_base_id": "kb-1",
                    "knowledge_base_name": "Quarterly",
                    "document_id": "doc-1",
                    "browser_open_url": "https://apgateway.erp.sina.com.cn/raw",
                }
            ],
        }

    with patch.object(ApKnowledgeMcpClient, "call_tool", fake_call):
        response = test_client.post(
            "/api/wecode/external-knowledge/ap/search",
            headers=auth_headers,
            json={
                "query": "plan",
                "knowledge_base_ids": ["kb-1"],
                "max_results": 10,
            },
        )

    assert response.status_code == 200
    body = response.json()
    assert body["records"][0]["source_uri"] == "ap://kb-1/doc-1"
    assert "browser_open_url" not in body["records"][0]
    assert "browser_open_url" not in response.text


def test_no_employee_id_returns_guidance_without_calling_ap(
    test_client: TestClient,
    auth_headers: dict[str, str],
):
    mock_call = AsyncMock()
    with patch.object(ApKnowledgeMcpClient, "call_tool", mock_call):
        response = test_client.get(
            "/api/wecode/external-knowledge/ap/knowledge-bases",
            headers=auth_headers,
        )

    assert response.status_code == 403
    assert response.json()["detail"]["code"] == "employee_id_required"
    mock_call.assert_not_called()


def test_employee_sync_in_progress_returns_retryable_error(
    test_client: TestClient,
    auth_headers: dict[str, str],
):
    mock_call = AsyncMock()
    with (
        patch.object(
            external_knowledge_service._erp_resolver,
            "resolve_employee_id_result",
            return_value=EmployeeIdResolution(EmployeeIdResolutionStatus.IN_PROGRESS),
        ),
        patch.object(ApKnowledgeMcpClient, "call_tool", mock_call),
    ):
        response = test_client.get(
            "/api/wecode/external-knowledge/ap/knowledge-bases",
            headers=auth_headers,
        )

    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "employee_id_unavailable"
    mock_call.assert_not_called()
