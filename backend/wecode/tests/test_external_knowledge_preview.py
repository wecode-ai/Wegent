# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from wecode.models.erp_user import WecodeErpUser
from wecode.service.external_knowledge.client import ApKnowledgeMcpClient
from wecode.service.external_knowledge.providers.ap import LIST_NODES_TOOL

pytestmark = pytest.mark.usefixtures("configure_external_knowledge")


def test_preview_c2_uses_single_layer_nodes_and_iframe_mode(
    test_client: TestClient,
    auth_headers: dict[str, str],
    erp_profile: WecodeErpUser,
):
    calls = []

    async def fake_call(self, name, arguments, employee_id):
        calls.append((name, arguments))
        assert name == LIST_NODES_TOOL
        return {
            "items": [
                {
                    "node_id": "document:doc-1",
                    "raw_id": "doc-1",
                    "node_type": "document",
                    "browser_open_url": (
                        "https://apgateway.erp.sina.com.cn/proxy/preview"
                    ),
                }
            ]
        }

    with patch.object(ApKnowledgeMcpClient, "call_tool", fake_call):
        response = test_client.get(
            "/api/wecode/external-knowledge/ap/preview",
            headers=auth_headers,
            params={
                "kb_id": "kb-1",
                "node_id": "document:doc-1",
                "folder_id": "folder-1",
            },
        )

    assert response.status_code == 200
    assert response.json() == {
        "url": "https://apgateway.erp.sina.com.cn/proxy/preview",
        "preview_mode": "iframe",
    }
    assert calls[0][1]["recursive"] is False
    assert calls[0][1]["folder_id"] == "folder-1"


def test_preview_node_id_without_folder_falls_back_to_recursive_nodes(
    test_client: TestClient,
    auth_headers: dict[str, str],
    erp_profile: WecodeErpUser,
):
    calls = []

    async def fake_call(self, name, arguments, employee_id):
        calls.append((name, arguments))
        assert name == LIST_NODES_TOOL
        if arguments.get("recursive") is False:
            return {"items": []}
        return {
            "items": [
                {
                    "node_id": "folder:folder-1",
                    "raw_id": "folder-1",
                    "node_type": "folder",
                    "children": [
                        {
                            "node_id": "document:doc-2",
                            "raw_id": "doc-2",
                            "node_type": "document",
                            "browser_open_url": (
                                "https://apgateway.erp.sina.com.cn/proxy/child-preview"
                            ),
                        }
                    ],
                }
            ]
        }

    with patch.object(ApKnowledgeMcpClient, "call_tool", fake_call):
        response = test_client.get(
            "/api/wecode/external-knowledge/ap/preview",
            headers=auth_headers,
            params={"kb_id": "kb-1", "node_id": "document:doc-2"},
        )

    assert response.status_code == 200
    assert response.json() == {
        "url": "https://apgateway.erp.sina.com.cn/proxy/child-preview",
        "preview_mode": "iframe",
    }
    assert [call[1]["recursive"] for call in calls] == [False, True]


def test_preview_c6_uses_recursive_nodes_and_new_tab_mode(
    test_client: TestClient,
    auth_headers: dict[str, str],
    erp_profile: WecodeErpUser,
):
    calls = []

    async def fake_call(self, name, arguments, employee_id):
        calls.append((name, arguments))
        assert name == LIST_NODES_TOOL
        return {
            "items": [
                {
                    "node_id": "folder:folder-1",
                    "raw_id": "folder-1",
                    "node_type": "folder",
                    "children": [
                        {
                            "node_id": "document:doc-2",
                            "raw_id": "doc-2",
                            "node_type": "document",
                            "browser_open_url": (
                                "https://alidocs.dingtalk.com/document"
                            ),
                        }
                    ],
                }
            ]
        }

    with patch.object(ApKnowledgeMcpClient, "call_tool", fake_call):
        response = test_client.get(
            "/api/wecode/external-knowledge/ap/preview",
            headers=auth_headers,
            params={"kb_id": "kb-1", "document_id": "doc-2"},
        )

    assert response.status_code == 200
    assert response.json() == {
        "url": "https://alidocs.dingtalk.com/document",
        "preview_mode": "new_tab",
    }
    assert calls[0][1]["recursive"] is True
    assert "folder_id" not in calls[0][1]


def test_preview_non_dingtalk_external_url_uses_new_tab_mode(
    test_client: TestClient,
    auth_headers: dict[str, str],
    erp_profile: WecodeErpUser,
):
    async def fake_call(self, name, arguments, employee_id):
        assert name == LIST_NODES_TOOL
        return {
            "items": [
                {
                    "node_id": "document:doc-3",
                    "raw_id": "doc-3",
                    "node_type": "document",
                    "browser_open_url": "https://example.com/document",
                }
            ]
        }

    with patch.object(ApKnowledgeMcpClient, "call_tool", fake_call):
        response = test_client.get(
            "/api/wecode/external-knowledge/ap/preview",
            headers=auth_headers,
            params={"kb_id": "kb-1", "document_id": "doc-3"},
        )

    assert response.status_code == 200
    assert response.json() == {
        "url": "https://example.com/document",
        "preview_mode": "new_tab",
    }


def test_preview_document_id_pages_recursive_nodes_until_match(
    test_client: TestClient,
    auth_headers: dict[str, str],
    erp_profile: WecodeErpUser,
):
    offsets = []

    async def fake_call(self, name, arguments, employee_id):
        offsets.append(arguments["offset"])
        assert name == LIST_NODES_TOOL
        assert arguments["recursive"] is True
        assert arguments["limit"] == 500
        if arguments["offset"] == 0:
            return {
                "total_returned": 500,
                "has_more": True,
                "items": [
                    {
                        "node_id": f"document:doc-{index}",
                        "raw_id": f"doc-{index}",
                        "node_type": "document",
                    }
                    for index in range(500)
                ],
            }
        return {
            "total_returned": 1,
            "has_more": False,
            "items": [
                {
                    "node_id": "document:doc-500",
                    "raw_id": "doc-500",
                    "node_type": "document",
                    "browser_open_url": "https://alidocs.dingtalk.com/document-500",
                }
            ],
        }

    with patch.object(ApKnowledgeMcpClient, "call_tool", fake_call):
        response = test_client.get(
            "/api/wecode/external-knowledge/ap/preview",
            headers=auth_headers,
            params={"kb_id": "kb-1", "document_id": "doc-500"},
        )

    assert response.status_code == 200
    assert response.json() == {
        "url": "https://alidocs.dingtalk.com/document-500",
        "preview_mode": "new_tab",
    }
    assert offsets == [0, 500]
