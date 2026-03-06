# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for KB Retrieval MCP tools."""

from unittest.mock import MagicMock, patch

import pytest

from app.mcp_server.auth import TaskTokenInfo


@pytest.fixture
def token_info():
    """Create a test token info."""
    return TaskTokenInfo(
        task_id=100,
        subtask_id=200,
        user_id=1,
        user_name="testuser",
    )


class TestKnowledgeBaseSearchTool:
    """Tests for knowledge_base_search MCP tool."""

    @patch("app.mcp_server.tools.kb_retrieval.SessionLocal")
    def test_search_returns_results(self, mock_session_local, token_info):
        """Test successful RAG search returns formatted results."""
        from app.mcp_server.tools.kb_retrieval import knowledge_base_search

        mock_db = MagicMock()
        mock_session_local.return_value = mock_db

        # Mock RetrievalService
        mock_service = MagicMock()
        mock_retrieval_result = {
            "records": [
                {"content": "Result 1 content", "score": 0.95, "title": "doc1.md"},
                {"content": "Result 2 content", "score": 0.85, "title": "doc2.md"},
            ]
        }

        with (
            patch(
                "app.services.rag.retrieval_service.RetrievalService",
                return_value=mock_service,
            ),
            patch("app.mcp_server.tools.kb_retrieval.asyncio") as mock_asyncio,
        ):
            mock_asyncio.get_event_loop.return_value.run_until_complete.return_value = (
                mock_retrieval_result
            )

            result = knowledge_base_search(
                token_info=token_info,
                query="test query",
                kb_id=10,
                max_results=5,
            )

        assert result["total"] == 2
        assert len(result["results"]) == 2
        assert result["results"][0]["content"] == "Result 1 content"
        assert result["results"][0]["score"] == 0.95
        assert result["results"][0]["title"] == "doc1.md"
        assert result["query"] == "test query"
        mock_db.close.assert_called_once()

    @patch("app.mcp_server.tools.kb_retrieval.SessionLocal")
    def test_search_limits_results(self, mock_session_local, token_info):
        """Test that max_results limits the number of returned results."""
        from app.mcp_server.tools.kb_retrieval import knowledge_base_search

        mock_db = MagicMock()
        mock_session_local.return_value = mock_db

        with patch("app.mcp_server.tools.kb_retrieval.asyncio") as mock_asyncio:
            mock_asyncio.get_event_loop.return_value.run_until_complete.return_value = {
                "records": [
                    {
                        "content": f"Result {i}",
                        "score": 0.9 - i * 0.1,
                        "title": f"doc{i}.md",
                    }
                    for i in range(10)
                ]
            }

            result = knowledge_base_search(
                token_info=token_info,
                query="test",
                kb_id=10,
                max_results=3,
            )

        assert result["total"] == 3
        assert len(result["results"]) == 3

    @patch("app.mcp_server.tools.kb_retrieval.SessionLocal")
    def test_search_handles_error(self, mock_session_local, token_info):
        """Test that errors are caught and returned as error dict."""
        from app.mcp_server.tools.kb_retrieval import knowledge_base_search

        mock_db = MagicMock()
        mock_session_local.return_value = mock_db

        with patch("app.mcp_server.tools.kb_retrieval.asyncio") as mock_asyncio:
            mock_asyncio.get_event_loop.return_value.run_until_complete.side_effect = (
                ValueError("KB not found")
            )

            result = knowledge_base_search(
                token_info=token_info,
                query="test",
                kb_id=999,
            )

        assert "error" in result
        assert "KB not found" in result["error"]
        mock_db.close.assert_called_once()


class TestKbLsTool:
    """Tests for kb_ls MCP tool."""

    @patch("app.mcp_server.tools.kb_retrieval.SessionLocal")
    def test_ls_returns_documents(self, mock_session_local, token_info):
        """Test listing documents from a knowledge base."""
        from app.mcp_server.tools.kb_retrieval import kb_ls

        mock_db = MagicMock()
        mock_session_local.return_value = mock_db

        # Mock document query results
        mock_doc1 = MagicMock()
        mock_doc1.id = 1
        mock_doc1.name = "readme.md"
        mock_doc1.file_extension = "md"
        mock_doc1.file_size = 1024
        mock_doc1.summary = {"short_summary": "Project readme"}
        mock_doc1.is_active = True

        mock_doc2 = MagicMock()
        mock_doc2.id = 2
        mock_doc2.name = "api.pdf"
        mock_doc2.file_extension = "pdf"
        mock_doc2.file_size = 2048
        mock_doc2.summary = None
        mock_doc2.is_active = True

        mock_query = MagicMock()
        mock_query.filter.return_value.order_by.return_value.all.return_value = [
            mock_doc1,
            mock_doc2,
        ]
        mock_db.query.return_value = mock_query

        result = kb_ls(token_info=token_info, kb_id=10)

        assert result["total"] == 2
        assert len(result["documents"]) == 2
        assert result["documents"][0]["name"] == "readme.md"
        assert result["documents"][0]["short_summary"] == "Project readme"
        assert result["documents"][1]["short_summary"] is None
        mock_db.close.assert_called_once()

    @patch("app.mcp_server.tools.kb_retrieval.SessionLocal")
    def test_ls_empty_kb(self, mock_session_local, token_info):
        """Test listing documents from an empty knowledge base."""
        from app.mcp_server.tools.kb_retrieval import kb_ls

        mock_db = MagicMock()
        mock_session_local.return_value = mock_db

        mock_query = MagicMock()
        mock_query.filter.return_value.order_by.return_value.all.return_value = []
        mock_db.query.return_value = mock_query

        result = kb_ls(token_info=token_info, kb_id=10)

        assert result["total"] == 0
        assert result["documents"] == []

    @patch("app.mcp_server.tools.kb_retrieval.SessionLocal")
    def test_ls_handles_error(self, mock_session_local, token_info):
        """Test that errors return error dict."""
        from app.mcp_server.tools.kb_retrieval import kb_ls

        mock_db = MagicMock()
        mock_session_local.return_value = mock_db
        mock_db.query.side_effect = Exception("DB error")

        result = kb_ls(token_info=token_info, kb_id=10)

        assert "error" in result
        assert "DB error" in result["error"]


class TestKbHeadTool:
    """Tests for kb_head MCP tool."""

    @patch("app.mcp_server.tools.kb_retrieval.SessionLocal")
    def test_head_returns_content(self, mock_session_local, token_info):
        """Test reading document content."""
        from app.mcp_server.tools.kb_retrieval import kb_head

        mock_db = MagicMock()
        mock_session_local.return_value = mock_db

        # Mock document
        mock_doc = MagicMock()
        mock_doc.id = 1
        mock_doc.name = "readme.md"
        mock_doc.attachment_id = 100
        mock_doc.kind_id = 10

        mock_query = MagicMock()
        mock_query.filter.return_value.first.return_value = mock_doc
        mock_db.query.return_value = mock_query

        # Mock attachment content
        mock_attachment = MagicMock()
        mock_attachment.extracted_text = "Hello world! This is test content."

        mock_ctx_svc = MagicMock()
        mock_ctx_svc.get_context_optional.return_value = mock_attachment

        with patch("app.services.context.context_service", mock_ctx_svc):
            result = kb_head(token_info=token_info, document_id=1)

        assert result["document_id"] == 1
        assert result["name"] == "readme.md"
        assert result["content"] == "Hello world! This is test content."
        assert result["total_length"] == 34
        assert result["offset"] == 0
        assert result["has_more"] is False
        mock_db.close.assert_called_once()

    @patch("app.mcp_server.tools.kb_retrieval.SessionLocal")
    def test_head_with_offset_and_limit(self, mock_session_local, token_info):
        """Test reading content with offset and limit pagination."""
        from app.mcp_server.tools.kb_retrieval import kb_head

        mock_db = MagicMock()
        mock_session_local.return_value = mock_db

        mock_doc = MagicMock()
        mock_doc.id = 1
        mock_doc.name = "large.md"
        mock_doc.attachment_id = 100
        mock_doc.kind_id = 10

        mock_query = MagicMock()
        mock_query.filter.return_value.first.return_value = mock_doc
        mock_db.query.return_value = mock_query

        full_content = "A" * 100  # 100 character content
        mock_attachment = MagicMock()
        mock_attachment.extracted_text = full_content

        mock_ctx_svc = MagicMock()
        mock_ctx_svc.get_context_optional.return_value = mock_attachment

        with patch("app.services.context.context_service", mock_ctx_svc):
            result = kb_head(token_info=token_info, document_id=1, offset=10, limit=20)

        assert result["offset"] == 10
        assert result["returned_length"] == 20
        assert result["total_length"] == 100
        assert result["has_more"] is True
        assert result["content"] == "A" * 20

    @patch("app.mcp_server.tools.kb_retrieval.SessionLocal")
    def test_head_document_not_found(self, mock_session_local, token_info):
        """Test reading a non-existent document."""
        from app.mcp_server.tools.kb_retrieval import kb_head

        mock_db = MagicMock()
        mock_session_local.return_value = mock_db

        mock_query = MagicMock()
        mock_query.filter.return_value.first.return_value = None
        mock_db.query.return_value = mock_query

        result = kb_head(token_info=token_info, document_id=999)

        assert "error" in result
        assert "not found" in result["error"]

    @patch("app.mcp_server.tools.kb_retrieval.SessionLocal")
    def test_head_clamps_limit_to_max(self, mock_session_local, token_info):
        """Test that limit is clamped to MAX_READ_DOC_LIMIT."""
        from app.mcp_server.tools.kb_retrieval import MAX_READ_DOC_LIMIT, kb_head

        mock_db = MagicMock()
        mock_session_local.return_value = mock_db

        mock_doc = MagicMock()
        mock_doc.id = 1
        mock_doc.name = "doc.md"
        mock_doc.attachment_id = 100
        mock_doc.kind_id = 10

        mock_query = MagicMock()
        mock_query.filter.return_value.first.return_value = mock_doc
        mock_db.query.return_value = mock_query

        # Content smaller than max limit
        content = "X" * 1000
        mock_attachment = MagicMock()
        mock_attachment.extracted_text = content

        mock_ctx_svc = MagicMock()
        mock_ctx_svc.get_context_optional.return_value = mock_attachment

        with patch("app.services.context.context_service", mock_ctx_svc):
            # Request limit larger than MAX_READ_DOC_LIMIT
            result = kb_head(
                token_info=token_info,
                document_id=1,
                limit=MAX_READ_DOC_LIMIT + 100000,
            )

        # Should still return all content since content < max limit
        assert result["returned_length"] == 1000


class TestKbRetrievalToolRegistration:
    """Tests for KB retrieval tool registration."""

    def test_tools_are_registered(self):
        """Test that all 3 KB retrieval tools are registered."""
        from app.mcp_server.tools.kb_retrieval import KB_RETRIEVAL_MCP_TOOLS

        assert "knowledge_base_search" in KB_RETRIEVAL_MCP_TOOLS
        assert "kb_ls" in KB_RETRIEVAL_MCP_TOOLS
        assert "kb_head" in KB_RETRIEVAL_MCP_TOOLS

    def test_tools_have_correct_server(self):
        """Test that tools are registered with correct server name."""
        from app.mcp_server.tools.decorator import get_registered_mcp_tools

        kb_tools = get_registered_mcp_tools(server="kb_retrieval")
        tool_names = set(kb_tools.keys())
        assert "knowledge_base_search" in tool_names
        assert "kb_ls" in tool_names
        assert "kb_head" in tool_names
