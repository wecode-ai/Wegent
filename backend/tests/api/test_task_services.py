# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for task services API endpoints."""

from types import SimpleNamespace
from typing import Generator, Optional
from unittest.mock import Mock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.dependencies import get_db
from app.api.endpoints.internal import services
from app.core.config import settings


@pytest.fixture
def internal_services(
    monkeypatch: pytest.MonkeyPatch,
) -> Generator[SimpleNamespace, None, None]:
    monkeypatch.setattr(settings, "INTERNAL_SERVICE_TOKEN", "test-internal-token")
    task = SimpleNamespace(
        json={"status": {"app": {"name": "Existing app", "address": "localhost:3000"}}}
    )
    store = Mock()
    store.get_task_by_states.return_value = task
    db = Mock()
    emitter = Mock()
    monkeypatch.setattr(services, "task_store", store)
    monkeypatch.setattr(services, "get_extended_emitter", lambda: emitter)
    monkeypatch.setattr(services, "get_main_event_loop", lambda: None)
    app = FastAPI()
    app.include_router(services.router, prefix="/api/internal")
    app.dependency_overrides[get_db] = lambda: db
    with TestClient(app) as client:
        yield SimpleNamespace(
            client=client, task=task, store=store, db=db, emitter=emitter
        )


class TestTaskServicesAPI:
    """Test cases for task services API endpoints."""

    def test_task_archive_route_precedes_dynamic_task_create_route(self):
        """Ensure POST /tasks/archive is not captured by POST /tasks/{task_id}."""
        from app.api.endpoints.adapter.tasks import router

        post_routes = [
            route.path
            for route in router.routes
            if "POST" in getattr(route, "methods", set())
        ]

        assert post_routes.index("/archive") < post_routes.index("/{task_id}")

    def test_service_update_schema(self):
        """Test ServiceUpdate schema accepts all fields."""
        from app.schemas.service import ServiceUpdate

        # Test with all fields
        update = ServiceUpdate(
            name="Test App",
            host="localhost",
            previewUrl="https://example.com",
            mysql="mysql://user:pass@localhost/db",
        )
        assert update.name == "Test App"
        assert update.host == "localhost"
        assert update.previewUrl == "https://example.com"
        assert update.mysql == "mysql://user:pass@localhost/db"

    def test_service_update_schema_optional_fields(self):
        """Test ServiceUpdate schema with partial fields."""
        from app.schemas.service import ServiceUpdate

        # Test with only name
        update = ServiceUpdate(name="Test App")
        assert update.name == "Test App"
        assert update.host is None
        assert update.previewUrl is None
        assert update.mysql is None

    def test_service_update_schema_empty(self):
        """Test ServiceUpdate schema with no fields."""
        from app.schemas.service import ServiceUpdate

        update = ServiceUpdate()
        assert update.name is None
        assert update.host is None
        assert update.previewUrl is None
        assert update.mysql is None

    def test_service_delete_request_schema(self):
        """Test ServiceDeleteRequest schema."""
        from app.schemas.service import ServiceDeleteRequest

        delete_req = ServiceDeleteRequest(fields=["mysql", "host"])
        assert delete_req.fields == ["mysql", "host"]

    def test_service_response_schema(self):
        """Test ServiceResponse schema."""
        from app.schemas.service import ServiceResponse

        response = ServiceResponse(app={"name": "Test App", "host": "localhost"})
        assert response.app == {"name": "Test App", "host": "localhost"}

    def test_service_response_schema_empty(self):
        """Test ServiceResponse schema with empty app."""
        from app.schemas.service import ServiceResponse

        response = ServiceResponse()
        assert response.app == {}

    def test_prompt_draft_generate_request_schema(self):
        """Test PromptDraftGenerateRequest schema."""
        from app.schemas.task import PromptDraftGenerateRequest

        request = PromptDraftGenerateRequest(model="gpt-5.4", source="pet_panel")
        assert request.model == "gpt-5.4"
        assert request.source == "pet_panel"

    def test_prompt_draft_generate_response_schema(self):
        """Test PromptDraftGenerateResponse schema."""
        from datetime import datetime, timezone

        from app.schemas.task import PromptDraftGenerateResponse

        response = PromptDraftGenerateResponse(
            title="协作提示词",
            prompt="你是产品协作助手，负责帮助我沉淀协作方式。",
            model="gpt-5.4",
            version=1,
            created_at=datetime(2026, 3, 28, 12, 0, 0, tzinfo=timezone.utc),
        )
        assert response.title == "协作提示词"
        assert response.prompt.startswith("你是")
        assert response.model == "gpt-5.4"
        assert response.version == 1


class TestInternalServicesAPI:
    """Test cases for internal services API endpoints."""

    @pytest.mark.parametrize(
        "authorization",
        [None, "Bearer invalid-token", "Basic test-internal-token"],
    )
    @pytest.mark.parametrize(
        "method,path",
        [("GET", "/health"), ("GET", "/123"), ("POST", "/update")],
    )
    def test_rejects_unauthorized_requests_without_side_effects(
        self,
        internal_services: SimpleNamespace,
        authorization: Optional[str],
        method: str,
        path: str,
    ) -> None:
        headers = {"Authorization": authorization} if authorization else {}

        response = internal_services.client.request(
            method,
            f"/api/internal/services{path}",
            headers=headers,
            json=(
                {"task_id": 123, "previewUrl": "https://preview.example.test/app"}
                if method == "POST"
                else None
            ),
        )

        assert response.status_code == 401
        assert response.headers["WWW-Authenticate"] == "Bearer"
        internal_services.store.get_task_by_states.assert_not_called()
        internal_services.store.update_json.assert_not_called()
        internal_services.db.commit.assert_not_called()
        internal_services.emitter.emit_task_app_update.assert_not_called()
        assert internal_services.task.json["status"]["app"] == {
            "name": "Existing app",
            "address": "localhost:3000",
        }

    def test_valid_token_updates_and_reads_merged_app(
        self, internal_services: SimpleNamespace
    ) -> None:
        headers = {"Authorization": "Bearer test-internal-token"}
        expected_app = {
            "name": "Existing app",
            "address": "localhost:3000",
            "previewUrl": "https://preview.example.test/app",
        }

        response = internal_services.client.post(
            "/api/internal/services/update",
            headers=headers,
            json={"task_id": 123, "previewUrl": expected_app["previewUrl"]},
        )

        assert response.status_code == 200
        assert response.json() == {"success": True, "app": expected_app}
        internal_services.store.update_json.assert_called_once_with(
            internal_services.db,
            task=internal_services.task,
            payload={"status": {"app": expected_app}},
        )
        internal_services.db.commit.assert_called_once_with()
        internal_services.db.refresh.assert_called_once_with(internal_services.task)
        read = internal_services.client.get(
            "/api/internal/services/123", headers=headers
        )
        assert read.status_code == 200
        assert read.json() == {"success": True, "app": expected_app}

    def test_unconfigured_token_rejects_writes(
        self,
        internal_services: SimpleNamespace,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.setattr(settings, "INTERNAL_SERVICE_TOKEN", "")

        response = internal_services.client.post(
            "/api/internal/services/update",
            headers={"Authorization": "Bearer test-internal-token"},
            json={"task_id": 123, "name": "Changed app"},
        )

        assert response.status_code == 401
        internal_services.store.update_json.assert_not_called()
        internal_services.db.commit.assert_not_called()
        internal_services.emitter.emit_task_app_update.assert_not_called()

    def test_internal_service_update_request_schema(self):
        """Test ServiceUpdateRequest schema for internal API."""
        from app.api.endpoints.internal.services import ServiceUpdateRequest

        request = ServiceUpdateRequest(
            task_id=123,
            name="Test App",
            address="localhost",
        )
        assert request.task_id == 123
        assert request.name == "Test App"
        assert request.address == "localhost"
        assert request.previewUrl is None
        assert request.mysql is None

    def test_internal_service_update_request_minimal(self):
        """Test ServiceUpdateRequest with only task_id."""
        from app.api.endpoints.internal.services import ServiceUpdateRequest

        request = ServiceUpdateRequest(task_id=456)
        assert request.task_id == 456
        assert request.name is None
