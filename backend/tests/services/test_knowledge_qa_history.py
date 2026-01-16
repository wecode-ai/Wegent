# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Unit tests for knowledge base QA history API.
"""

from datetime import datetime, timedelta
from unittest.mock import MagicMock, patch

import pytest
from shared.models.db.enums import SubtaskRole
from shared.models.db.subtask_context import SubtaskContext
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.subtask import Subtask
from app.schemas.knowledge_qa_history import (
    KnowledgeBaseConfigInfo,
    KnowledgeBaseResult,
    KnowledgeBaseTypeData,
    PaginationInfo,
    QAHistoryItem,
    QAHistoryResponse,
    RetrievalConfigInfo,
)
from app.services.knowledge.knowledge_base_qa_service import (
    MAX_QUERY_DAYS,
    KnowledgeBaseQAService,
    knowledge_base_qa_service,
)


class TestKnowledgeBaseQAServiceValidation:
    """Test validation logic in KnowledgeBaseQAService."""

    def test_validate_time_range_valid(self):
        """Test valid time range passes validation."""
        start_time = datetime.now() - timedelta(days=7)
        end_time = datetime.now()

        # Should not raise
        KnowledgeBaseQAService.validate_time_range(start_time, end_time)

    def test_validate_time_range_start_after_end(self):
        """Test that start_time after end_time raises ValueError."""
        start_time = datetime.now()
        end_time = datetime.now() - timedelta(days=1)

        with pytest.raises(
            ValueError, match="start_time must be earlier than end_time"
        ):
            KnowledgeBaseQAService.validate_time_range(start_time, end_time)

    def test_validate_time_range_equal_times(self):
        """Test that equal start and end times raises ValueError."""
        now = datetime.now()

        with pytest.raises(
            ValueError, match="start_time must be earlier than end_time"
        ):
            KnowledgeBaseQAService.validate_time_range(now, now)

    def test_validate_time_range_exceeds_max_days(self):
        """Test that time range exceeding MAX_QUERY_DAYS raises ValueError."""
        start_time = datetime.now() - timedelta(days=MAX_QUERY_DAYS + 1)
        end_time = datetime.now()

        with pytest.raises(
            ValueError, match=f"Query time range cannot exceed {MAX_QUERY_DAYS} days"
        ):
            KnowledgeBaseQAService.validate_time_range(start_time, end_time)

    def test_validate_time_range_exactly_max_days(self):
        """Test that time range exactly at MAX_QUERY_DAYS passes validation."""
        # Use a fixed point in time to avoid microsecond precision issues
        end_time = datetime(2024, 1, 31, 12, 0, 0)
        start_time = end_time - timedelta(days=MAX_QUERY_DAYS)

        # Should not raise
        KnowledgeBaseQAService.validate_time_range(start_time, end_time)


class TestKnowledgeBaseQAServiceQuery:
    """Test query logic in KnowledgeBaseQAService."""

    def test_get_qa_history_empty_result(self, test_db: Session):
        """Test get_qa_history returns empty result when no data."""
        start_time = datetime.now() - timedelta(days=7)
        end_time = datetime.now()

        result = knowledge_base_qa_service.get_qa_history(
            db=test_db,
            start_time=start_time,
            end_time=end_time,
        )

        assert isinstance(result, QAHistoryResponse)
        assert result.items == []
        assert result.pagination.total == 0
        assert result.pagination.page == 1
        assert result.pagination.page_size == 20
        assert result.pagination.total_pages == 1

    def test_get_qa_history_with_pagination(self, test_db: Session):
        """Test pagination parameters are applied correctly."""
        start_time = datetime.now() - timedelta(days=7)
        end_time = datetime.now()

        result = knowledge_base_qa_service.get_qa_history(
            db=test_db,
            start_time=start_time,
            end_time=end_time,
            page=2,
            page_size=10,
        )

        assert result.pagination.page == 2
        assert result.pagination.page_size == 10

    def test_get_qa_history_page_size_limit(self, test_db: Session):
        """Test that page_size is capped at 100."""
        start_time = datetime.now() - timedelta(days=7)
        end_time = datetime.now()

        result = knowledge_base_qa_service.get_qa_history(
            db=test_db,
            start_time=start_time,
            end_time=end_time,
            page_size=200,
        )

        assert result.pagination.page_size == 100

    def test_get_qa_history_invalid_page_defaults_to_1(self, test_db: Session):
        """Test that invalid page number defaults to 1."""
        start_time = datetime.now() - timedelta(days=7)
        end_time = datetime.now()

        result = knowledge_base_qa_service.get_qa_history(
            db=test_db,
            start_time=start_time,
            end_time=end_time,
            page=0,
        )

        assert result.pagination.page == 1

    def test_get_qa_history_with_user_id_filter(self, test_db: Session, test_user):
        """Test filtering by user_id."""
        start_time = datetime.now() - timedelta(days=7)
        end_time = datetime.now()

        result = knowledge_base_qa_service.get_qa_history(
            db=test_db,
            start_time=start_time,
            end_time=end_time,
            user_id=test_user.id,
        )

        assert isinstance(result, QAHistoryResponse)
        # With no matching data, should return empty list
        assert result.items == []


class TestKnowledgeBaseQAServiceHelpers:
    """Test helper methods in KnowledgeBaseQAService."""

    def test_parse_knowledge_base_result_with_data(self):
        """Test parsing knowledge base result with valid data."""
        mock_context = MagicMock()
        mock_context.id = 1
        mock_context.extracted_text = "Test extracted content"
        mock_context.type_data = {
            "knowledge_id": 10,
            "document_count": 5,
            "sources": [{"document_id": "doc1", "score": 0.95}],
        }

        result = KnowledgeBaseQAService._parse_knowledge_base_result(mock_context)

        assert isinstance(result, KnowledgeBaseResult)
        assert result.extracted_text == "Test extracted content"
        assert result.type_data.knowledge_id == 10
        assert result.type_data.document_count == 5

    def test_parse_knowledge_base_result_with_empty_data(self):
        """Test parsing knowledge base result with empty data."""
        mock_context = MagicMock()
        mock_context.id = 1
        mock_context.extracted_text = ""
        mock_context.type_data = {}

        result = KnowledgeBaseQAService._parse_knowledge_base_result(mock_context)

        assert isinstance(result, KnowledgeBaseResult)
        assert result.extracted_text is None
        assert result.type_data.knowledge_id is None

    def test_get_knowledge_base_config_not_found(self, test_db: Session):
        """Test getting config for non-existent knowledge base."""
        result = KnowledgeBaseQAService._get_knowledge_base_config(test_db, 99999)

        assert result is None

    def test_get_knowledge_base_config_success(self, test_db: Session, test_user):
        """Test getting config for existing knowledge base."""
        # Create a test knowledge base
        kb = Kind(
            user_id=test_user.id,
            kind="KnowledgeBase",
            name="test-kb",
            namespace="default",
            json={
                "spec": {
                    "name": "Test Knowledge Base",
                    "description": "A test KB",
                    "retrievalConfig": {
                        "retriever_name": "test-retriever",
                        "retriever_namespace": "default",
                        "embedding_config": {
                            "model_name": "text-embedding-3-small",
                            "model_namespace": "default",
                        },
                        "retrieval_mode": "vector",
                        "top_k": 5,
                        "score_threshold": 0.7,
                    },
                }
            },
            is_active=True,
        )
        test_db.add(kb)
        test_db.commit()
        test_db.refresh(kb)

        result = KnowledgeBaseQAService._get_knowledge_base_config(test_db, kb.id)

        assert isinstance(result, KnowledgeBaseConfigInfo)
        assert result.id == kb.id
        assert result.name == "Test Knowledge Base"
        assert result.retrieval_config is not None
        assert result.retrieval_config.retriever_name == "test-retriever"
        assert result.retrieval_config.top_k == 5


class TestQAHistoryAPI:
    """Test the QA history API endpoint."""

    def test_get_qa_history_requires_auth(self, test_client):
        """Test that the endpoint requires authentication."""
        response = test_client.get(
            "/api/v1/knowledge-base/qa-history",
            params={
                "start_time": (datetime.now() - timedelta(days=7)).isoformat(),
                "end_time": datetime.now().isoformat(),
            },
        )

        assert response.status_code == 401

    def test_get_qa_history_missing_params(self, test_client, test_token):
        """Test that missing required params returns 422."""
        response = test_client.get(
            "/api/v1/knowledge-base/qa-history",
            headers={"Authorization": f"Bearer {test_token}"},
        )

        assert response.status_code == 422

    def test_get_qa_history_success(self, test_client, test_token):
        """Test successful QA history query."""
        response = test_client.get(
            "/api/v1/knowledge-base/qa-history",
            params={
                "start_time": (datetime.now() - timedelta(days=7)).isoformat(),
                "end_time": datetime.now().isoformat(),
            },
            headers={"Authorization": f"Bearer {test_token}"},
        )

        assert response.status_code == 200
        data = response.json()
        assert "items" in data
        assert "pagination" in data
        assert data["pagination"]["page"] == 1
        assert data["pagination"]["page_size"] == 20

    def test_get_qa_history_with_pagination_params(self, test_client, test_token):
        """Test QA history query with pagination parameters."""
        response = test_client.get(
            "/api/v1/knowledge-base/qa-history",
            params={
                "start_time": (datetime.now() - timedelta(days=7)).isoformat(),
                "end_time": datetime.now().isoformat(),
                "page": 2,
                "page_size": 50,
            },
            headers={"Authorization": f"Bearer {test_token}"},
        )

        assert response.status_code == 200
        data = response.json()
        assert data["pagination"]["page"] == 2
        assert data["pagination"]["page_size"] == 50

    def test_get_qa_history_invalid_time_range(self, test_client, test_token):
        """Test QA history query with invalid time range."""
        response = test_client.get(
            "/api/v1/knowledge-base/qa-history",
            params={
                "start_time": datetime.now().isoformat(),
                "end_time": (datetime.now() - timedelta(days=7)).isoformat(),
            },
            headers={"Authorization": f"Bearer {test_token}"},
        )

        assert response.status_code == 400
        assert "start_time must be earlier than end_time" in response.json()["detail"]

    def test_get_qa_history_time_range_too_large(self, test_client, test_token):
        """Test QA history query with time range exceeding limit."""
        response = test_client.get(
            "/api/v1/knowledge-base/qa-history",
            params={
                "start_time": (
                    datetime.now() - timedelta(days=MAX_QUERY_DAYS + 5)
                ).isoformat(),
                "end_time": datetime.now().isoformat(),
            },
            headers={"Authorization": f"Bearer {test_token}"},
        )

        assert response.status_code == 400
        assert (
            f"Query time range cannot exceed {MAX_QUERY_DAYS} days"
            in response.json()["detail"]
        )

    def test_get_qa_history_with_user_id_filter(
        self, test_client, test_token, test_user
    ):
        """Test QA history query with user_id filter."""
        response = test_client.get(
            "/api/v1/knowledge-base/qa-history",
            params={
                "start_time": (datetime.now() - timedelta(days=7)).isoformat(),
                "end_time": datetime.now().isoformat(),
                "user_id": test_user.id,
            },
            headers={"Authorization": f"Bearer {test_token}"},
        )

        assert response.status_code == 200
        data = response.json()
        assert "items" in data

    def test_get_qa_history_page_size_max(self, test_client, test_token):
        """Test that page_size above 100 is rejected."""
        response = test_client.get(
            "/api/v1/knowledge-base/qa-history",
            params={
                "start_time": (datetime.now() - timedelta(days=7)).isoformat(),
                "end_time": datetime.now().isoformat(),
                "page_size": 150,
            },
            headers={"Authorization": f"Bearer {test_token}"},
        )

        # FastAPI Query validation should reject page_size > 100
        assert response.status_code == 422


class TestQAHistorySchemas:
    """Test the Pydantic schemas for QA history."""

    def test_qa_history_item_schema(self):
        """Test QAHistoryItem schema validation."""
        item = QAHistoryItem(
            task_id=1,
            user_id=1,
            subtask_id=1,
            subtask_context_id=1,
            user_prompt="What is Python?",
            assistant_answer="Python is a programming language.",
            knowledge_base_result=KnowledgeBaseResult(
                extracted_text="Python info",
                type_data=KnowledgeBaseTypeData(
                    knowledge_id=1,
                    document_count=5,
                ),
            ),
            created_at=datetime.now(),
        )

        assert item.task_id == 1
        assert item.user_prompt == "What is Python?"

    def test_pagination_info_schema(self):
        """Test PaginationInfo schema validation."""
        pagination = PaginationInfo(
            page=1,
            page_size=20,
            total=100,
            total_pages=5,
        )

        assert pagination.page == 1
        assert pagination.total_pages == 5

    def test_qa_history_response_schema(self):
        """Test QAHistoryResponse schema validation."""
        response = QAHistoryResponse(
            items=[],
            pagination=PaginationInfo(
                page=1,
                page_size=20,
                total=0,
                total_pages=1,
            ),
        )

        assert response.items == []
        assert response.pagination.total == 0
