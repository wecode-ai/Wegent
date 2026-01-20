# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Unit tests for PPTX context storage functionality."""

import pytest
from unittest.mock import MagicMock, patch

from app.schemas.subtask_context import (
    ContextType,
    GeneratedPPTXContextCreate,
    GeneratedPPTXResponse,
    SubtaskContextBrief,
)


class TestGeneratedPPTXSchemas:
    """Tests for PPTX-related schema classes."""

    def test_generated_pptx_context_create_minimal(self):
        """Test minimal GeneratedPPTXContextCreate creation."""
        data = GeneratedPPTXContextCreate(
            name="test.pptx",
            slide_count=5,
            pptx_attachment_id=123,
        )
        assert data.name == "test.pptx"
        assert data.slide_count == 5
        assert data.pptx_attachment_id == 123
        assert data.preview_images == []

    def test_generated_pptx_context_create_with_previews(self):
        """Test GeneratedPPTXContextCreate with preview images."""
        data = GeneratedPPTXContextCreate(
            name="presentation.pptx",
            slide_count=10,
            pptx_attachment_id=456,
            preview_images=[101, 102, 103],
        )
        assert len(data.preview_images) == 3
        assert data.preview_images == [101, 102, 103]

    def test_generated_pptx_response_from_context(self):
        """Test GeneratedPPTXResponse.from_context method."""
        # Mock a SubtaskContext object
        mock_context = MagicMock()
        mock_context.id = 1
        mock_context.name = "test_presentation.pptx"
        mock_context.status = "ready"
        mock_context.type_data = {
            "slide_count": 8,
            "pptx_attachment_id": 789,
            "preview_images": [201, 202],
            "file_size": 50000,
        }
        mock_context.created_at = None

        response = GeneratedPPTXResponse.from_context(mock_context)

        assert response.id == 1
        assert response.name == "test_presentation.pptx"
        assert response.status == "ready"
        assert response.slide_count == 8
        assert response.pptx_attachment_id == 789
        assert response.preview_images == [201, 202]
        assert response.file_size == 50000


class TestSubtaskContextBriefPPTX:
    """Tests for SubtaskContextBrief with PPTX type."""

    def test_from_model_generated_pptx(self):
        """Test SubtaskContextBrief.from_model for GENERATED_PPTX type."""
        mock_context = MagicMock()
        mock_context.id = 10
        mock_context.context_type = ContextType.GENERATED_PPTX
        mock_context.name = "quarterly_report.pptx"
        mock_context.status = "ready"
        mock_context.type_data = {
            "slide_count": 15,
            "preview_images": [301, 302, 303],
            "pptx_attachment_id": 400,
            "file_size": 100000,
            "file_extension": ".pptx",
            "mime_type": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        }

        brief = SubtaskContextBrief.from_model(mock_context)

        assert brief.id == 10
        assert brief.context_type == ContextType.GENERATED_PPTX
        assert brief.name == "quarterly_report.pptx"
        assert brief.status == "ready"
        assert brief.slide_count == 15
        assert brief.preview_images == [301, 302, 303]
        assert brief.pptx_attachment_id == 400
        assert brief.file_size == 100000
        assert brief.file_extension == ".pptx"

    def test_from_model_attachment_unchanged(self):
        """Test that attachment type still works correctly."""
        mock_context = MagicMock()
        mock_context.id = 20
        mock_context.context_type = ContextType.ATTACHMENT
        mock_context.name = "document.pdf"
        mock_context.status = "ready"
        mock_context.type_data = {
            "file_size": 25000,
            "file_extension": ".pdf",
            "mime_type": "application/pdf",
        }

        brief = SubtaskContextBrief.from_model(mock_context)

        assert brief.id == 20
        assert brief.context_type == ContextType.ATTACHMENT
        assert brief.name == "document.pdf"
        assert brief.file_size == 25000
        # PPTX-specific fields should be None for attachment type
        assert brief.slide_count is None
        assert brief.preview_images is None
        assert brief.pptx_attachment_id is None


class TestContextTypeEnum:
    """Tests for ContextType enum."""

    def test_generated_pptx_type_exists(self):
        """Test that GENERATED_PPTX type is available."""
        assert hasattr(ContextType, "GENERATED_PPTX")
        assert ContextType.GENERATED_PPTX.value == "generated_pptx"

    def test_all_context_types(self):
        """Test all expected context types exist."""
        expected_types = [
            "attachment",
            "knowledge_base",
            "table",
            "selected_documents",
            "generated_pptx",
        ]
        for type_value in expected_types:
            assert any(ct.value == type_value for ct in ContextType)
