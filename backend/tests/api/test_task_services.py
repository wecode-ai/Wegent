# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for task services API endpoints."""


class TestTaskServicesAPI:
    """Test cases for task services API endpoints."""

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
