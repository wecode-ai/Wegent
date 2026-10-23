# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Contracts for restored Python routes through the registered API application."""

import asyncio
from datetime import datetime, timezone
from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient
from starlette.routing import Mount

from app.core.rate_limit import ExternalMcpRateLimitStatus
from app.core.security import get_auth_context, get_current_user
from app.models.knowledge_artifact import KnowledgeArtifactRecord
from app.schemas.knowledge import (
    DocumentSourceType,
    KnowledgeBaseCreate,
    KnowledgeDocumentCreate,
)
from app.services.knowledge.knowledge_service import KnowledgeService
from app.services.wiki.service import WikiConnectionService

SESSION_ROUTES = [
    "/api/knowledge-bases/{knowledge_base_id}/document-protection",
    "/api/knowledge-bases/{knowledge_base_id}/folders",
    "/api/knowledge-bases/{kb_id}/documents/{doc_id}/detail",
    "/api/knowledge-bases/{knowledge_base_id}/artifacts",
    "/api/wiki/connections",
    "/api/share/KnowledgeBase/{resource_id}/my-permission",
]
OPEN_ROUTES = [
    "/api/knowledge/documents",
    "/api/knowledge/documents/{document_id}/content",
]


def test_wiki_connection_database_read_runs_outside_event_loop(
    test_client, test_token, monkeypatch
):
    """Keep synchronous SQLAlchemy reads off the ASGI event loop."""
    list_connections = WikiConnectionService.list_connections

    def read_connections(db, user):
        with pytest.raises(RuntimeError, match="no running event loop"):
            asyncio.get_running_loop()
        return list_connections(db, user)

    monkeypatch.setattr(
        WikiConnectionService, "list_connections", staticmethod(read_connections)
    )
    response = test_client.get(
        "/api/wiki/connections", headers={"Authorization": f"Bearer {test_token}"}
    )
    assert response.status_code == 200
    assert response.json()["connections"] == []


def _dependencies(dependant):
    for dependency in dependant.dependencies:
        yield dependency.call
        yield from _dependencies(dependency)


@pytest.mark.parametrize(
    ("path", "authentication"),
    [(path, get_current_user) for path in SESSION_ROUTES]
    + [(path, get_auth_context) for path in OPEN_ROUTES],
)
def test_restored_get_is_registered_with_authentication(test_app, path, authentication):
    routes = [
        route
        for route in test_app.routes
        if isinstance(route, APIRoute) and route.path == path and "GET" in route.methods
    ]
    assert len(routes) == 1
    assert authentication in set(_dependencies(routes[0].dependant))


@pytest.mark.parametrize(
    "path",
    [
        "/api/knowledge-bases/1/document-protection",
        "/api/knowledge-bases/1/folders",
        "/api/knowledge-bases/1/documents/1/detail",
        "/api/knowledge-bases/1/artifacts",
        "/api/wiki/connections",
        "/api/share/KnowledgeBase/1/my-permission",
        "/api/knowledge/documents?knowledge_base_id=1",
        "/api/knowledge/documents/1/content?knowledge_base_id=1",
    ],
)
def test_restored_get_rejects_anonymous_requests(test_client, path):
    assert test_client.get(path).status_code == 401


def _create_kb(db, user_id, name):
    return KnowledgeService.create_knowledge_base(
        db, user_id, KnowledgeBaseCreate(name=name)
    )


def _create_document(db, kb_id, user_id, name):
    return KnowledgeService.create_document(
        db,
        kb_id,
        user_id,
        KnowledgeDocumentCreate(
            name=name,
            file_extension="md",
            file_size=10,
            source_type=DocumentSourceType.TEXT,
        ),
    )


def test_open_document_list_filters_paginates_and_isolates_libraries(
    test_client, test_db, test_user, test_token
):
    kb_id = _create_kb(test_db, test_user.id, "list-contract")
    other_kb = _create_kb(test_db, test_user.id, "other-list-contract")
    for name in ["alpha-1", "alpha-2", "beta"]:
        _create_document(test_db, kb_id, test_user.id, name)
    _create_document(test_db, other_kb, test_user.id, "alpha-foreign")
    response = test_client.get(
        "/api/knowledge/documents",
        params={
            "knowledge_base_id": kb_id,
            "keyword": "alpha",
            "sort_by": "name",
            "sort_order": "asc",
            "limit": 1,
            "offset": 1,
        },
        headers={"Authorization": f"Bearer {test_token}"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["total"] == 2
    assert len(body["items"]) == 1
    item = body["items"][0]
    assert item["name"] == "alpha-2"
    assert {"id", "name", "index_status", "source_type", "file_size"} <= item.keys()


@pytest.mark.parametrize("nonempty", [False, True])
def test_artifact_list_reopens_persisted_results(
    test_client, test_db, test_user, test_token, nonempty
):
    kb_id = _create_kb(test_db, test_user.id, "artifact-contract")
    if nonempty:
        now = datetime.now(timezone.utc).replace(tzinfo=None)
        test_db.add(
            KnowledgeArtifactRecord(
                artifact_id="persisted-artifact",
                knowledge_base_id=kb_id,
                artifact_type="briefing",
                title="Persisted result",
                status="succeeded",
                content="Stored content",
                source_document_ids=[],
                generation_config={},
                user_id=test_user.id,
                created_at=now,
                updated_at=now,
            )
        )
        test_db.commit()
    test_db.expire_all()
    url = f"/api/knowledge-bases/{kb_id}/artifacts"
    headers = {"Authorization": f"Bearer {test_token}"}
    first = test_client.get(url, headers=headers)
    reopened = test_client.get(url, headers=headers)
    assert first.status_code == reopened.status_code == 200
    assert first.json() == reopened.json()
    body = reopened.json()
    assert body["can_manage"] is True
    assert body["available_document_count"] == 0
    assert body["processing_document_count"] == 0
    assert len(body["items"]) == int(nonempty)
    if nonempty:
        item = body["items"][0]
        assert item["artifact_id"] == "persisted-artifact"
        assert item["status"] == "succeeded"
        assert item["content"] == "Stored content"
        assert item["can_delete"] is True
        assert item["can_retry"] is False


@pytest.mark.parametrize("resource", ["artifacts", "folders", "document-protection"])
def test_restored_library_reads_reject_nonmembers(
    test_client, test_db, test_user, test_admin_user, test_admin_token, resource
):
    kb_id = _create_kb(test_db, test_user.id, "private-library")
    response = test_client.get(
        f"/api/knowledge-bases/{kb_id}/{resource}",
        headers={"Authorization": f"Bearer {test_admin_token}"},
    )
    assert response.status_code == 404


def test_mcp_api_prefixed_mount_registers_get_download(monkeypatch):
    from app.core.config import settings
    from app.mcp_server.server import register_mcp_apps

    monkeypatch.setattr(settings, "EXTERNAL_KNOWLEDGE_MCP_ENABLED", True)
    app = FastAPI()
    register_mcp_apps(app, mount_prefix="/api")
    mount = next(
        route
        for route in app.routes
        if isinstance(route, Mount) and route.path == "/api/mcp/knowledge-external"
    )
    download = next(
        route
        for route in mount.app.routes
        if route.path == "/documents/{document_id:int}/file"
    )
    assert {"GET", "HEAD"} <= download.methods
    with patch(
        "app.mcp_server.external_knowledge_app.check_external_mcp_dimension_rate_limit",
        return_value=ExternalMcpRateLimitStatus.ALLOWED,
    ):
        response = TestClient(app).get("/api/mcp/knowledge-external/documents/1/file")
    assert response.status_code == 401
    assert response.json() == {
        "error": "Invalid or expired download token",
        "code": "unauthorized",
    }


def test_scoped_detail_rejects_document_from_another_accessible_library(
    test_client, test_db, test_user, test_token
):
    kb_id = _create_kb(test_db, test_user.id, "detail-boundary")
    other_kb = _create_kb(test_db, test_user.id, "foreign-detail")
    document = _create_document(test_db, other_kb, test_user.id, "foreign-document")
    response = test_client.get(
        f"/api/knowledge-bases/{kb_id}/documents/{document.id}/detail",
        headers={"Authorization": f"Bearer {test_token}"},
    )
    assert response.status_code == 404
    assert (
        response.json()["detail"]
        == "Document not found in the specified knowledge base"
    )


def test_protected_library_returns_watermark_and_private_cache(
    test_client, test_db, test_user, test_token
):
    kb_id = KnowledgeService.create_knowledge_base(
        test_db,
        test_user.id,
        KnowledgeBaseCreate(name="protected-library", allow_document_download=False),
    )
    response = test_client.get(
        f"/api/knowledge-bases/{kb_id}/document-protection",
        headers={"Authorization": f"Bearer {test_token}"},
    )
    assert response.status_code == 200
    assert response.headers["cache-control"] == "private, no-store"
    assert response.json() == {
        "original_download_allowed": False,
        "watermark_text": test_user.user_name,
    }
